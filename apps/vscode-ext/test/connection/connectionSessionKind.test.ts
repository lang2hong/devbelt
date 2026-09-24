import { describe, expect, it } from 'vitest';
import {
  NotSqlSessionError,
  assertSqlSession,
  requireSqlSession,
} from '../../src/connection/connectionSession';
import type {
  ConnectionSession,
  RedisConnectionSession,
  SqlConnectionSession,
} from '../../src/connection/connectionSession';

const redisSession: RedisConnectionSession = {
  kind: 'redis',
  client: {} as RedisConnectionSession['client'],
  db: 0,
  mode: 'standalone',
  readOnly: false,
  isAlive: () => true,
  close: () => {},
};

function sqlSession(): SqlConnectionSession {
  return {
    kind: 'sql',
    capabilities: {} as SqlConnectionSession['capabilities'],
    query: {} as SqlConnectionSession['query'],
    metadata: {} as SqlConnectionSession['metadata'],
    data: {} as SqlConnectionSession['data'],
    table: {} as SqlConnectionSession['table'],
    isAlive: () => true,
    close: () => {},
  };
}

/** 以联合类型形参接收，防止调用点把窄类型直接当联合用而被 TS 流分析收窄。 */
function widen(session: ConnectionSession): ConnectionSession {
  return session;
}

describe('ConnectionSession 判别联合（P7 S1）', () => {
  it('SQL 会话带 kind=sql，Redis 会话带 kind=redis', () => {
    expect(sqlSession().kind).toBe('sql');
    expect(redisSession.kind).toBe('redis');
  });

  it('assertSqlSession 对 Redis 会话抛 NotSqlSessionError', () => {
    expect(() => assertSqlSession(redisSession)).toThrow(NotSqlSessionError);
    expect(() => assertSqlSession(redisSession)).toThrow(/got 'redis'/);
  });

  it('assertSqlSession 对 SQL 会话不抛', () => {
    expect(() => assertSqlSession(sqlSession())).not.toThrow();
  });

  it('requireSqlSession 返回原 SQL 会话，对 Redis 抛错', () => {
    const sql = sqlSession();
    expect(requireSqlSession(sql)).toBe(sql);
    expect(() => requireSqlSession(redisSession)).toThrow(NotSqlSessionError);
  });

  it('kind 收窄后可安全访问引擎专属字段', () => {
    // 经 ConnectionSession 形参传入，避免初始化处的字面量窄化（否则 TS 认为 kind 恒为 redis）。
    const session: ConnectionSession = widen(redisSession);
    if (session.kind === 'sql') throw new Error('expected redis, got sql');
    expect(session.db).toBe(0);
    expect(session.mode).toBe('standalone');
    expect(session.readOnly).toBe(false);
  });
});
