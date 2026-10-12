import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { peekSqlForConnection } from '../../src/ai/sessionLookup';

/** 假 manager：peekSql(id, db) 按 `id` 或 `id||db` 键取会话，并记录调用参数。 */
function fakeManager(sessions: Record<string, object>): {
  manager: any;
  calls: Array<[string, string | undefined]>;
} {
  const calls: Array<[string, string | undefined]> = [];
  const manager = {
    peekSql: (id: string, db?: string) => {
      calls.push([id, db]);
      const key = db === undefined ? id : `${id}||${db}`;
      return sessions[key];
    },
  };
  return { manager, calls };
}

const mysqlConn = { id: 'c1', dbType: DatabaseType.MYSQL, database: 'app' } as never;
const pgConn = { id: 'c2', dbType: DatabaseType.PG, database: 'main' } as never;

describe('peekSqlForConnection（键规则对齐 ConnectionManager.connect）', () => {
  it('MySQL + 默认库：查主会话键（库名不参与查找）——修复"连接未打开"误报', () => {
    const main = { kind: 'sql', id: 'main' };
    const { manager, calls } = fakeManager({ c1: main });
    expect(peekSqlForConnection(manager, mysqlConn, 'app')).toBe(main);
    expect(calls).toEqual([['c1', undefined]]);
  });

  it('MySQL 无默认库：同样主会话键', () => {
    const main = { kind: 'sql' };
    const { manager, calls } = fakeManager({ c1: main });
    expect(peekSqlForConnection(manager, mysqlConn, undefined)).toBe(main);
    expect(calls).toEqual([['c1', undefined]]);
  });

  it('PG + 配置库：主会话键', () => {
    const main = { kind: 'sql' };
    const { manager, calls } = fakeManager({ c2: main });
    expect(peekSqlForConnection(manager, pgConn, 'main')).toBe(main);
    expect(calls).toEqual([['c2', undefined]]);
  });

  it('PG + 异库：优先库衍生会话；衍生缺失时不回退主会话（防串库）', () => {
    const derived = { kind: 'sql', db: 'other' };
    const first = fakeManager({ c2: derived, 'c2||other': derived });
    expect(peekSqlForConnection(first.manager, pgConn, 'other')).toBe(derived);

    const mainOnly = fakeManager({ c2: { kind: 'sql', db: 'main' } });
    expect(peekSqlForConnection(mainOnly.manager, pgConn, 'other')).toBeUndefined();
    expect(mainOnly.calls).toEqual([['c2', 'other']]);
  });

  it('PG 无库：主会话键', () => {
    const main = { kind: 'sql' };
    const { manager, calls } = fakeManager({ c2: main });
    expect(peekSqlForConnection(manager, pgConn, undefined)).toBe(main);
    expect(calls).toEqual([['c2', undefined]]);
  });
});
