import { describe, expect, it } from 'vitest';
import { sanitizeDiagnosePayload } from '../../src/ai/diagnosePayload';

/**
 * 错误诊断载荷 host 侧二次脱敏（P9 S6）：
 * 即便 webview 已显式确认（secretRisk 闸门通过），host 仍不信任入站消息。
 */
describe('sanitizeDiagnosePayload', () => {
  it('干净输入：message / sql / dbType 原样保留', () => {
    const payload = sanitizeDiagnosePayload({
      message: 'Unknown column x',
      sql: 'SELECT x FROM t',
      dbType: 'MYSQL',
    });
    expect(payload).toEqual({ error: 'Unknown column x', sql: 'SELECT x FROM t', dbType: 'MYSQL' });
  });

  it('message 命中口令模式 → 整段替换 [REDACTED]（局部替换会漏出引号字面量）', () => {
    const payload = sanitizeDiagnosePayload({
      message: "Access denied; WITH PASSWORD 'hunter2' rejected",
      dbType: 'MYSQL',
    });
    expect(payload.error).toBe('[REDACTED]');
    expect(payload.error).not.toContain('hunter2');
    expect(payload.dbType).toBe('MYSQL');
  });

  it('sql 命中口令模式 → 整个字段剔除（undefined 表达）', () => {
    const payload = sanitizeDiagnosePayload({
      message: 'syntax error',
      sql: "CREATE USER u IDENTIFIED BY 'pw'",
    });
    expect(payload.sql).toBeUndefined();
    expect(payload.error).toBe('syntax error');
  });

  it('非字符串/空 sql（伪造消息）按缺失处理；空 sql 不发送', () => {
    expect(sanitizeDiagnosePayload({ message: 'x', sql: '   ' }).sql).toBeUndefined();
    expect(sanitizeDiagnosePayload({ message: 'x', sql: 42 }).sql).toBeUndefined();
    expect(sanitizeDiagnosePayload({ message: 'x', dbType: 123 }).dbType).toBeUndefined();
    expect(sanitizeDiagnosePayload({}).error).toBe('');
  });
});