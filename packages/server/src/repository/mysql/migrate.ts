/**
 * 版本化迁移 runner，替代旧的补丁式建表（addColumnIfMissing/addIndexIfMissing）。
 *
 * 设计要点：
 * - `schema_migrations` 表记录已应用版本，runner 只执行未应用的 migration，保证幂等。
 * - migration 按传入顺序执行，每个成功后立即 INSERT 版本行。
 *   **不包外层事务**：MySQL 的 DDL 隐式提交，跨表迁移无法用事务原子性回滚；
 *   版本行紧跟迁移本身，一旦某步失败，重跑时已成功的前缀会被跳过。
 * - `query` 返回 mysql2 的 `[rows, fields]` 元组（与现有 repo/schema.ts 约定一致）。
 */

export type MigrationDb = {
  query(sql: string, params?: any[]): Promise<any>;
};

export interface Migration {
  version: string;
  up(db: MigrationDb): Promise<void>;
}

export async function runMigrations(db: MigrationDb, migrations: Migration[]): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL PRIMARY KEY,
      applied_time DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [rows] = (await db.query('SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
  const applied = new Set<string>(rows.map((r) => r.version));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await migration.up(db);
    await db.query('INSERT INTO schema_migrations (version, applied_time) VALUES (?, NOW())', [migration.version]);
  }
}