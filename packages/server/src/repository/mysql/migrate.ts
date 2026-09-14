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

/**
 * 把数据库账本里已应用的版本号归一化为当前 migration 集合的版本。
 *
 * 遗留账本兼容：历史 `${version}_v3` 键（旧补丁式建表时代遗留）视为已应用同名迁移。
 * 该归一化是迁移 runner 与就绪检查（/health/ready 的 schema 比对）共用的口径，
 * 二者必须一致，否则旧库升级后会被就绪检查永久判为「未迁移」而 503。
 */
export function normalizeAppliedVersions(appliedVersions: string[], migrations: readonly Migration[]): Set<string> {
  const legacyAliases = new Map(migrations.map((m) => [`${m.version}_v3`, m.version]));
  return new Set(appliedVersions.map((v) => legacyAliases.get(v) ?? v));
}

export async function runMigrations(db: MigrationDb, migrations: Migration[]): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL PRIMARY KEY,
      applied_time DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const [rows] = (await db.query('SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
  const applied = normalizeAppliedVersions(rows.map((r) => r.version), migrations);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await migration.up(db);
    // 多实例并发启动时，两个进程可能同时判定「未应用」并各自跑完幂等 UP，随后都在此记账；
    // ON DUPLICATE KEY UPDATE 使同版本重复插入退化为 no-op，避免后到者因主键冲突而启动失败。
    await db.query(
      'INSERT INTO schema_migrations (version, applied_time) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE applied_time = applied_time',
      [migration.version],
    );
  }
}