import { describe, expect, it } from 'vitest';
import { auditEventLabel } from './auditLabels';

describe('auditEventLabel', () => {
  it('刷新令牌复用事件有中文标签（扩展/控制台）', () => {
    expect(auditEventLabel('auth.refresh.reuse')).toContain('刷新令牌');
    expect(auditEventLabel('auth.refresh.reuse')).toContain('安全事件');
    expect(auditEventLabel('console.auth.refresh.reuse')).toContain('控制台');
  });

  it('未知事件回退原值', () => {
    expect(auditEventLabel('unknown.event')).toBe('unknown.event');
  });
});