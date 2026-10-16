import { describe, expect, it } from 'vitest';
import { canAutoRunForReply } from '../../src/ai/autoRunGuard';

const conn = { dbType: 'MYSQL', environment: 'development' };
const bound = { connId: 'c1', scope: 'db1' };

describe('canAutoRunForReply（回复级自动执行门禁）', () => {
  it('连接/库一致、非生产、关系引擎 → 允许', () => {
    expect(canAutoRunForReply(bound, { connId: 'c1', scope: 'db1' }, conn)).toBe(true);
    expect(canAutoRunForReply({ connId: 'c1' }, { connId: 'c1' }, { dbType: 'PG' })).toBe(true);
  });

  it('生成期间换连接 → 拒绝', () => {
    expect(canAutoRunForReply(bound, { connId: 'c2', scope: 'db1' }, conn)).toBe(false);
  });

  it('生成期间换库 → 拒绝', () => {
    expect(canAutoRunForReply(bound, { connId: 'c1', scope: 'db2' }, conn)).toBe(false);
  });

  it('生产连接 → 拒绝', () => {
    expect(canAutoRunForReply(bound, bound, { ...conn, environment: 'production' })).toBe(false);
  });

  it('非关系引擎 / 缺绑定 / 缺连接 → 拒绝', () => {
    expect(canAutoRunForReply(bound, bound, { dbType: 'REDIS' })).toBe(false);
    expect(canAutoRunForReply(bound, bound, { dbType: 'ELASTICSEARCH' })).toBe(false);
    expect(canAutoRunForReply(undefined, bound, conn)).toBe(false);
    expect(canAutoRunForReply({ scope: 'db1' }, { scope: 'db1' }, conn)).toBe(false);
    expect(canAutoRunForReply(bound, bound, undefined)).toBe(false);
  });
});
