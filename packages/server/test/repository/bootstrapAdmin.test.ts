import { describe, expect, it } from 'vitest';
import { bootstrapInitialAdmin } from '../../src/repository/mysql/bootstrapAdmin.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

function makeDb(opts: { existingUser?: boolean; hasFreePlan?: boolean } = {}) {
  const statements: Array<{ sql: string; params?: any[] }> = [];
  let begin = 0;
  let commit = 0;
  let rollback = 0;
  let release = 0;

  const tx = {
    query: async (sql: string, params?: any[]) => {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT id FROM users')) return [opts.existingUser ? [{ id: 1 }] : [], []];
      if (sql.startsWith('SELECT id FROM plans')) return [opts.hasFreePlan === false ? [] : [{ id: 2 }], []];
      if (sql.includes('INSERT INTO users')) return [{ insertId: 10 }, []];
      if (sql.includes('INSERT INTO organizations')) return [{ insertId: 20 }, []];
      if (sql.includes('INSERT INTO subscriptions')) return [{ insertId: 30 }, []];
      return [{ affectedRows: 1 }, []];
    },
    beginTransaction: async () => { begin++; },
    commit: async () => { commit++; },
    rollback: async () => { rollback++; },
    release: () => { release++; },
  };
  const db = {
    database: 'test',
    query: tx.query,
    getConnection: async () => tx,
  } as unknown as MysqlDb;

  return { db, statements, counts: () => ({ begin, commit, rollback, release }) };
}

describe('bootstrapInitialAdmin', () => {
  it('creates a system admin with a personal org, subscription, and seat atomically', async () => {
    const fake = makeDb();
    const result = await bootstrapInitialAdmin(fake.db, {
      email: ' Admin@Example.com ', password: 'strong-password', displayName: 'Admin',
    });

    expect(result).toEqual({ userId: 10, organizationId: 20 });
    expect(fake.counts()).toEqual({ begin: 1, commit: 1, rollback: 0, release: 1 });

    const userInsert = fake.statements.find((s) => s.sql.includes('INSERT INTO users'))!;
    expect(userInsert.params?.[0]).toBe('admin@example.com');
    expect(userInsert.params?.[1]).toMatch(/^scrypt\$/);
    expect(userInsert.params?.[2]).toBe('Admin');

    expect(fake.statements.some((s) => s.sql.includes("VALUES (?, ?, 'admin', 'active')"))).toBe(true);
    expect(fake.statements.some((s) => s.sql.includes("VALUES (?, ?, 'active', 'manual')"))).toBe(true);
    expect(fake.statements.some((s) => s.sql.includes("VALUES (?, ?, 'active')"))).toBe(true);
  });

  it('rolls back when the bootstrap email already exists', async () => {
    const fake = makeDb({ existingUser: true });
    await expect(bootstrapInitialAdmin(fake.db, {
      email: 'admin@example.com', password: 'strong-password',
    })).rejects.toThrow('user already exists');
    expect(fake.counts()).toEqual({ begin: 1, commit: 0, rollback: 1, release: 1 });
  });
});
