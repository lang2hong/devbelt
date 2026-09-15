import type { FastifyInstance } from 'fastify';
import { normalizeAppliedVersions, type Migration } from '../repository/mysql/migrate.js';
import type { Queryable } from '../repository/mysql/db.js';

/** readiness 探活的数据库查询超时：避免 DB 假死时探针无限挂起、拖垮 k8s/负载均衡摘除。 */
const DB_PING_TIMEOUT_MS = 2000;

/** 给查询加超时，任一失败（含超时）都按「不可用」处理。定时器必须清理，避免探针累积。 */
export function pingDb(db: Queryable, sql: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('db ping timeout')), DB_PING_TIMEOUT_MS);
    // 健康探针不应拽住进程退出。
    timer.unref();
    db.query(sql).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface HealthRoutesOptions {
  /** 期望已应用的 migration 集合（就绪时逐个比对 schema_migrations 账本）。 */
  migrations: readonly Migration[];
  getDb: () => Queryable;
  /** 邮件发送器已初始化：production 缺 SMTP 在启动期即失败，故此处恒 true（§11.1 就绪表）。 */
  mailReady: boolean;
}

/**
 * 健康检查（§11.1）：`/health/live` 进程存活（不连 DB）；`/health/ready` 就绪检查
 * （DB 连通 + schema 账本对齐 + mail 依赖就绪），200/503。两者均 `Cache-Control:
 * no-store`、不设 Cookie、响应体 < 500 字节、不泄露版本号 / 库名 / hostname。
 */
export async function registerHealthRoutes(app: FastifyInstance, opts: HealthRoutesOptions): Promise<void> {
  app.get('/health/live', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.send({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const db = opts.getDb();

    let dbOk = false;
    let schemaOk = false;
    try {
      await pingDb(db, 'SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    if (dbOk) {
      try {
        const [rows] = (await pingDb(db, 'SELECT version FROM schema_migrations')) as [Array<{ version: string }>, unknown];
        // 与迁移 runner 共用同一份遗留别名归一化（${version}_v3），避免旧账本被误判未迁移而永久 503。
        const applied = normalizeAppliedVersions(rows.map((r) => r.version), opts.migrations);
        const known = new Set(opts.migrations.map((m) => m.version));
        // 就绪要求：当前 binary 需要的迁移全部已应用，且账本里没有当前 binary 不认识的版本
        // （后者即「用旧 binary 回滚到已跑新迁移的库」，schema 应判 pending 拒绝流量）。
        const missing = opts.migrations.some((m) => !applied.has(m.version));
        const unknown = [...applied].some((v) => !known.has(v));
        schemaOk = !missing && !unknown;
      } catch {
        schemaOk = false;
      }
    }

    const ready = dbOk && schemaOk && opts.mailReady;
    reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      schema: dbOk ? (schemaOk ? 'ok' : 'pending') : 'down',
      mail: opts.mailReady ? 'ok' : 'down',
    });
  });
}