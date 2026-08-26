import { describe, it, expect } from 'vitest';
import { runMigrations, type Migration } from '../../src/repository/mysql/migrate.js';
import { initialSchemaV2 } from '../../src/repository/mysql/migrations/001_initial_schema.js';
import { seedPlansV2 } from '../../src/repository/mysql/migrations/002_seed_plans.js';
import { migrations } from '../../src/repository/mysql/migrations/index.js';

/**
 * fake 连接：不连 MySQL，只记录执行过的 SQL，并模拟 schema_migrations 表的状态。
 * query 返回 mysql2 的 `[rows, fields]` 元组。
 */
function fakeDb() {
  const executed: string[] = [];
  const appliedVersions = new Set<string>();
  return {
    executed,
    appliedVersions,
    query: async (sql: string, params?: any[]) => {
      executed.push(sql);
      if (sql.trimStart().startsWith('SELECT version FROM schema_migrations')) {
        return [[...appliedVersions].map((v) => ({ version: v })), []];
      }
      if (sql.trimStart().startsWith('INSERT INTO schema_migrations')) {
        appliedVersions.add(params?.[0] as string);
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
  };
}

function createTableCount(executed: string[]): number {
  return executed.filter((sql) => sql.includes('CREATE TABLE')).length;
}

describe('runMigrations', () => {
  it('首次运行：建 schema_migrations、建核心表、播种套餐并记录版本', async () => {
    const db = fakeDb();
    await runMigrations(db, migrations as Migration[]);

    // runner 自建 schema_migrations + 16 张核心业务表
    expect(createTableCount(db.executed)).toBe(18);
    expect(db.appliedVersions.has(initialSchemaV2.version)).toBe(true);
    expect(db.appliedVersions.has(seedPlansV2.version)).toBe(true);

    // 关键表必须都在 DDL 里露过面（防止漏表）
    const ddl = db.executed.join('\n');
    for (const t of ['users', 'organizations', 'memberships', 'plans', 'subscriptions', 'orders', 'seats', 'organization_resources', 'organization_resource_permissions', 'organization_audit_log', 'sync_sections', 'connection_meta', 'admin_audit_log']) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
    expect(ddl).toContain('per_seat_max_devices');
    expect(ddl).toContain('org_max_shared_connections');
    expect(ddl).toContain("CHECK (role IN ('admin', 'member'))");
    expect(db.executed.filter((sql) => sql.includes('INSERT INTO plans')).length).toBe(3);
  });

  it('已应用的迁移不重复执行（幂等）', async () => {
    const db = fakeDb();
    await runMigrations(db, migrations as Migration[]);
    const before = db.executed.length;

    await runMigrations(db, migrations as Migration[]);

    // 第二次只做 schema_migrations 的 CREATE IF NOT EXISTS + SELECT，不再跑业务 DDL
    const afterExec = db.executed.slice(before);
    expect(createTableCount(afterExec)).toBe(1); // 仅 schema_migrations 自建
    expect(afterExec.some((sql) => sql.startsWith('INSERT INTO schema_migrations'))).toBe(false);
  });

  it('多条迁移按序执行，跳过已应用者', async () => {
    // 全量按序执行
    const db = fakeDb();
    const trace: string[] = [];
    const migrations: Migration[] = ['001', '002', '003'].map((v) => ({
      version: v,
      up: async () => { trace.push(v); },
    }));
    await runMigrations(db, migrations);
    expect(trace).toEqual(['001', '002', '003']);

    // 预置 002 已应用 → 跳过 002，其余按序执行
    const db2 = fakeDb();
    db2.appliedVersions.add('002');
    const trace2: string[] = [];
    const migrations2: Migration[] = ['001', '002', '003'].map((v) => ({
      version: v,
      up: async () => { trace2.push(v); },
    }));
    await runMigrations(db2, migrations2);
    expect(trace2).toEqual(['001', '003']);
  });
});
