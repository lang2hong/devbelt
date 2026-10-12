import { describe, expect, it, vi } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import {
  currentDatabase,
  listScopes,
  parseDatabasesCount,
  pickScope,
  scopeKindOf,
} from '../../src/ai/scopeOptions';

function mysqlConn() {
  return { id: 'm1', dbType: DatabaseType.MYSQL, database: 'app' } as never;
}
function redisConn(redisDb = 3) {
  return { id: 'r1', dbType: DatabaseType.REDIS, redisDb } as never;
}
function esConn() {
  return { id: 'e1', dbType: DatabaseType.ELASTICSEARCH } as never;
}
function sqliteConn() {
  return { id: 's1', dbType: DatabaseType.SQLITE } as never;
}

describe('scopeKindOf（引擎 → 作用域语义）', () => {
  it('MySQL/PG → database；Redis → redis-db；ES → index；SQLite → none', () => {
    expect(scopeKindOf(DatabaseType.MYSQL)).toBe('database');
    expect(scopeKindOf(DatabaseType.PG)).toBe('database');
    expect(scopeKindOf(DatabaseType.REDIS)).toBe('redis-db');
    expect(scopeKindOf(DatabaseType.ELASTICSEARCH)).toBe('index');
    expect(scopeKindOf(DatabaseType.SQLITE)).toBe('none');
  });
});

describe('listScopes', () => {
  it('MySQL：过滤系统库', async () => {
    const session = {
      kind: 'sql',
      metadata: { getDatabases: vi.fn(async () => ['db_client_dev', 'information_schema', 'mysql', 'performance_schema', 'sys', 'db_client']) },
    } as never;
    const scopes = await listScopes(mysqlConn(), session);
    expect(scopes).toEqual({ kind: 'database', options: ['db_client_dev', 'db_client'] });
  });

  it('PG：过滤 template0/1', async () => {
    const session = {
      kind: 'sql',
      metadata: { getDatabases: vi.fn(async () => ['postgres', 'template0', 'template1', 'app']) },
    } as never;
    const scopes = await listScopes({ id: 'p1', dbType: DatabaseType.PG, database: '' } as never, session);
    expect(scopes.options).toEqual(['postgres', 'app']);
  });

  it('SQLite：none 空列表', async () => {
    const scopes = await listScopes(sqliteConn(), { kind: 'sql' } as never);
    expect(scopes).toEqual({ kind: 'none', options: [] });
  });

  it('Redis：CONFIG 上限 ∪ 非空库 ∪ 当前库/配置库；cluster 恒 db0', async () => {
    const sendCommand = vi.fn(async (name: string) => {
      if (name === 'CONFIG') return [['databases', '16']];
      return undefined;
    });
    const session = {
      kind: 'redis',
      db: 0,
      client: {
        isCluster: false,
        info: vi.fn(async () => 'db0:keys=10,expires=0\ndb3:keys=2,expires=0'),
        sendCommand,
      },
    } as never;
    const scopes = await listScopes(redisConn(3), session);
    expect(scopes.kind).toBe('redis-db');
    expect(scopes.options).toHaveLength(16);
    expect(scopes.options[0]).toBe('0');
    expect(scopes.options[15]).toBe('15');

    const cluster = {
      kind: 'redis',
      db: 0,
      client: { isCluster: true, info: vi.fn(), sendCommand: vi.fn() },
    } as never;
    expect((await listScopes(redisConn(), cluster)).options).toEqual(['0']);
  });

  it('Redis：CONFIG 被禁用 → 非空库 ∪ 当前库 ∪ 配置库', async () => {
    const session = {
      kind: 'redis',
      db: 0,
      client: {
        isCluster: false,
        info: vi.fn(async () => 'db0:keys=10\ndb5:keys=1'),
        sendCommand: vi.fn(async () => {
          throw new Error('NOPERM');
        }),
      },
    } as never;
    expect((await listScopes(redisConn(3), session)).options).toEqual(['0', '3', '5']);
  });

  it('ES：_cat/indices 过滤系统索引（.开头）；非 2xx/异常 → 空', async () => {
    const session = {
      kind: 'elasticsearch',
      es: {
        request: vi.fn(async () => ({
          status: 200,
          body: [{ index: 'orders' }, { index: '.kibana_1' }, { index: 'users' }],
        })),
      },
    } as never;
    expect((await listScopes(esConn(), session)).options).toEqual(['orders', 'users']);

    const failing = {
      kind: 'elasticsearch',
      es: { request: vi.fn(async () => ({ status: 403, body: {} })) },
    } as never;
    expect((await listScopes(esConn(), failing)).options).toEqual([]);
  });

  it('会话类型与引擎不匹配 → 空列表（不抛）', async () => {
    expect((await listScopes(mysqlConn(), { kind: 'redis' } as never)).options).toEqual([]);
  });
});

describe('pickScope（单选默认顺序）', () => {
  it('上次选择有效 → 用它；无效 → 连接默认库；都不行 → 第一项；无候选 → undefined', () => {
    expect(pickScope(['a', 'b'], 'b', 'a')).toBe('b');
    expect(pickScope(['a', 'b'], 'zz', 'b')).toBe('b');
    expect(pickScope(['a', 'b'], undefined, undefined)).toBe('a');
    expect(pickScope([], 'a', 'b')).toBeUndefined();
  });
});

describe('parseDatabasesCount（兼容 flat/嵌套/对象）', () => {
  it('三种回包形态', () => {
    expect(parseDatabasesCount(['databases', '16'])).toBe(16);
    expect(parseDatabasesCount([['databases', '4']])).toBe(4);
    expect(parseDatabasesCount({ databases: '8' })).toBe(8);
    expect(parseDatabasesCount([['maxclients', '100']])).toBeUndefined();
  });
});

describe('currentDatabase', () => {
  it('MySQL: SELECT DATABASE()；行值兼容大小写别名', async () => {
    const session = { query: { query: vi.fn(async () => ({ rows: [{ db: 'app' }] })) } } as never;
    expect(await currentDatabase(session, 'MYSQL')).toBe('app');
  });

  it('值为 null / 查询失败 → undefined', async () => {
    const nul = { query: { query: vi.fn(async () => ({ rows: [{ db: null }] })) } } as never;
    expect(await currentDatabase(nul, 'mysql')).toBeUndefined();
    const fail = { query: { query: vi.fn(async () => { throw new Error('x'); }) } } as never;
    expect(await currentDatabase(fail, 'pg')).toBeUndefined();
  });
});
