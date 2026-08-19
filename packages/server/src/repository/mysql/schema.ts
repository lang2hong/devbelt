import type { FastifyInstance } from 'fastify';

/**
 * 初始化数据库 schema（幂等）。
 * 建表 + plans 数据播种 + 旧表(users)补列。
 * 旧表 sync_data 暂保留兼容，期四切换 sync_sections 后废弃。
 *
 * 建库不在此处：`app.mysql` 是**连接池**，`USE db` 只对池中借出的那一条连接生效，
 * 其余连接仍无默认库，并发起来会 `ER_NO_DB_ERROR`。库的创建改由 `ensureDatabase()`
 * 在注册池之前用一条临时连接完成，池本身带 `database` 参数，见 app.ts。
 */
export async function initSchema(app: FastifyInstance): Promise<void> {
  const mysql = app.mysql;

  // plans 套餐定义表
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(40) NOT NULL,
      price_month INT UNSIGNED NOT NULL DEFAULT 0,
      price_year INT UNSIGNED NOT NULL DEFAULT 0,
      max_devices SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      max_connections SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      sync_quota_bytes INT UNSIGNED NOT NULL DEFAULT 0,
      sync_version_retention SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      history_retention_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      features INT UNSIGNED NOT NULL DEFAULT 0,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // 旧 plans 表补列（若已存在）
  await addColumnIfMissing(mysql, 'plans', 'sync_version_retention', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumnIfMissing(mysql, 'plans', 'max_connections', 'SMALLINT UNSIGNED NOT NULL DEFAULT 0');

  // users 表（新增字段幂等 ALTER；旧表若存在则补列）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'user',
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      plan_code VARCHAR(16) NOT NULL DEFAULT 'free',
      last_login_time TIMESTAMP NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  // 旧 users 表补列
  await addColumnIfMissing(mysql, 'users', 'status', "VARCHAR(16) NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(mysql, 'users', 'plan_code', "VARCHAR(16) NOT NULL DEFAULT 'free'");
  await addColumnIfMissing(mysql, 'users', 'last_login_time', "TIMESTAMP NULL DEFAULT NULL");
  await addColumnIfMissing(mysql, 'users', 'update_time', "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");

  // subscriptions 订阅表（一用户一行）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      plan_code VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      period_end_time TIMESTAMP NOT NULL,
      trial_end_time TIMESTAMP NULL DEFAULT NULL,
      cancel_time TIMESTAMP NULL DEFAULT NULL,
      provider VARCHAR(32) NOT NULL DEFAULT 'manual',
      external_id VARCHAR(255) NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_sub_user (user_id)
    ) ENGINE=InnoDB
  `);

  // refresh_tokens 设备会话表
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      device_name VARCHAR(120) NULL,
      device_id VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      ip VARCHAR(45) NULL,
      expires_time TIMESTAMP NOT NULL,
      revoked_time TIMESTAMP NULL DEFAULT NULL,
      last_used_time TIMESTAMP NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_rt_user (user_id, revoked_time, expires_time)
    ) ENGINE=InnoDB
  `);
  // 旧 refresh_tokens 表补 device_id 列
  await addColumnIfMissing(mysql, 'refresh_tokens', 'device_id', 'VARCHAR(64) NULL');

  // devices 设备实体表（同设备判同 + 设备固有信息，区别于易变的会话表）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      device_id VARCHAR(64) NOT NULL,
      hostname VARCHAR(120) NULL,
      os VARCHAR(32) NULL,
      arch VARCHAR(16) NULL,
      os_version VARCHAR(64) NULL,
      app_name VARCHAR(64) NULL,
      app_version VARCHAR(32) NULL,
      remote_name VARCHAR(32) NULL,
      vs_machine_id VARCHAR(64) NULL,
      language VARCHAR(16) NULL,
      timezone VARCHAR(64) NULL,
      last_seen_time TIMESTAMP NULL DEFAULT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_device_user (user_id, device_id)
    ) ENGINE=InnoDB
  `);
  // 旧 devices 表补列
  await addColumnIfMissing(mysql, 'devices', 'vs_machine_id', 'VARCHAR(64) NULL');
  await addColumnIfMissing(mysql, 'devices', 'language', 'VARCHAR(16) NULL');
  await addColumnIfMissing(mysql, 'devices', 'timezone', 'VARCHAR(64) NULL');

  // device_events 设备事件留痕表（升级/系统变化/首次登记）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS device_events (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      device_id VARCHAR(64) NOT NULL,
      event VARCHAR(16) NOT NULL,
      vs_machine_id VARCHAR(64) NULL,
      app_name VARCHAR(64) NULL,
      app_version VARCHAR(32) NULL,
      os VARCHAR(32) NULL,
      os_version VARCHAR(64) NULL,
      arch VARCHAR(16) NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_de_user_device (user_id, device_id, create_time)
    ) ENGINE=InnoDB
  `);

  // connection_meta 连接元数据表（明文，服务端计量/分析用；内容仍加密存于 sync_sections）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS connection_meta (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      conn_uuid VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      name VARCHAR(200) NULL,
      group_name VARCHAR(100) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      deleted TINYINT(1) NOT NULL DEFAULT 0,
      created_at BIGINT NULL,
      updated_at BIGINT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_cm_user_conn (user_id, conn_uuid)
    ) ENGINE=InnoDB
  `);

  // sync_events 同步事件留痕表（每次 pull/push 的明文元数据）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS sync_events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      device_id VARCHAR(64) NULL,
      direction VARCHAR(8) NOT NULL,
      section VARCHAR(16) NOT NULL,
      bytes INT UNSIGNED NOT NULL DEFAULT 0,
      item_count INT UNSIGNED NOT NULL DEFAULT 0,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_se_user (user_id, create_time)
    ) ENGINE=InnoDB
  `);

  // usage_events 用量行为表（连接打开/查询执行的累计计数，明文）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      device_id VARCHAR(64) NULL,
      kind VARCHAR(32) NOT NULL,
      count INT UNSIGNED NOT NULL DEFAULT 1,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      KEY idx_ue_user (user_id, create_time)
    ) ENGINE=InnoDB
  `);

  // sync_sections 分节同步当前版本表（方案 A）
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS sync_sections (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      section VARCHAR(16) NOT NULL,
      encrypted_data MEDIUMTEXT NOT NULL,
      version INT UNSIGNED NOT NULL DEFAULT 1,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ss_user_section (user_id, section),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  /**
   * sync_section_versions 历史版本表（回滚用）。
   *
   * (user_id, section, version) 必须**唯一**。此前只有一个普通索引，于是同一
   * 版本号可以存在多行 —— `getVersion` 取 `rows[0]` 等于随机挑一条，回滚到
   * 哪份内容不可预测；`pruneVersions` 的「保留最新 N 条」也会把重复行算进去，
   * 实际保留的版本数少于套餐承诺。重复行的来源是旧 rollback 实现的丢写竞态
   * （两个并发回滚都写 current+1）。
   *
   * 唯一键同时覆盖了原 idx_sv_user_section 的全部前缀查询，新库不再单独建那个
   * 普通索引；老库上它已经存在，留着只多一份写入开销，不值得为此加一次 DROP。
   */
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS sync_section_versions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      section VARCHAR(16) NOT NULL,
      version INT UNSIGNED NOT NULL,
      encrypted_data MEDIUMTEXT NOT NULL,
      data_bytes INT UNSIGNED NOT NULL DEFAULT 0,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_sv_user_section (user_id, section, version)
    ) ENGINE=InnoDB
  `);
  // 老库补唯一键（表已存在时 CREATE TABLE IF NOT EXISTS 不会改结构）
  await addIndexIfMissing(
    mysql,
    'sync_section_versions',
    'uq_sv_user_section',
    'UNIQUE KEY `uq_sv_user_section` (user_id, section, version)',
    app.log,
  );

  /**
   * traffic_stats 流量统计（小时粒度聚合）。
   *
   * 刻意**不记录每个请求**：一条一行的话 100 用户开自动同步一天就是几十万行，
   * 而这张表的用途是看趋势，分辨率到小时足够。分钟级实时曲线走内存环形缓冲
   * （见 observability/trafficCollector.ts），进程重启即丢，这是有意的取舍。
   *
   * 无 user_id、无外键：未认证流量（login/register/404/静态资源）根本没有 user，
   * 加了列也只能填 NULL，反而让主键和查询都变复杂。
   *
   * route 存的是**路由模板**（`/admin/users/:id`）而非实际路径，否则基数无界会打爆表。
   * status_class = floor(status/100)，即 2/3/4/5。
   *
   * 容量：27 路由 × 5 状态类 × 24 桶 ≈ 每天上限 3240 行，实际远低于此。
   * **没有清理任务** —— 这个量级下不值得再引入一个会出错的定时任务。
   */
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS traffic_stats (
      bucket_time DATETIME NOT NULL,
      route VARCHAR(80) NOT NULL,
      status_class TINYINT UNSIGNED NOT NULL,
      count INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket_time, route, status_class)
    ) ENGINE=InnoDB
  `);

  /**
   * traffic_blocked 被限流拦截的请求（429 逐条记录）。
   *
   * 为什么不合进 traffic_stats：那里的 status_class=4 把 400/401/403/404/429
   * 混在一起，看不出是不是限流挡的。而 429 恰恰是最需要精确定位的 ——
   * 「谁被挡了、挡在哪个端点」直接决定阈值该不该放宽。
   *
   * 逐条记录是安全的：正常情况下 429 应该极少；真被打的时候这张表的增长
   * 本身就是告警信号。
   */
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS traffic_blocked (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ip VARCHAR(45) NOT NULL,
      route VARCHAR(80) NOT NULL,
      bucket VARCHAR(32) NOT NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tb_time (create_time),
      KEY idx_tb_ip (ip, create_time)
    ) ENGINE=InnoDB
  `);

  /**
   * rate_limit_rules 限流阈值覆盖表。
   *
   * 只存**覆盖行**，不是全量配置：代码里的 DEFAULT_RULES 是基线，这张表为空
   * 时限流照常工作。这样 DB 读失败不会让限流失效（回落到默认值即可），
   * 也不需要在部署时先播种数据。
   *
   * 启动时读进内存，后台改动同时写 DB + 更新内存。单实例下内存即权威值，
   * 没有 TTL 缓存、没有每请求查库、没有陈旧窗口。
   */
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_rules (
      bucket VARCHAR(32) NOT NULL PRIMARY KEY,
      max_requests INT UNSIGNED NOT NULL,
      window_seconds INT UNSIGNED NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      update_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  /**
   * rate_limit_allowlist 免限流 IP。
   *
   * 存在的理由很具体：多个用户在同一间办公室共用出口 IP 时，按 IP 分桶会把
   * 整个办公室算成一个人。这是按 IP 限流的固有缺陷（限流跑在 onRequest，
   * 早于 jwtVerify，拿不到 req.user，只能按 IP 分）。
   */
  await mysql.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_allowlist (
      ip VARCHAR(45) NOT NULL PRIMARY KEY,
      note VARCHAR(120) NULL,
      create_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);

  /**
   * 清理与到期扫描所依赖的索引。
   *
   * 这些不是「优化」，是让相关语句可用的前提：
   *
   * - 事件表的清理是 `DELETE ... WHERE create_time < ? LIMIT 2000`。已有的
   *   `idx_se_user (user_id, create_time)` 帮不上忙 —— create_time 不是最左
   *   前缀，优化器只能全表扫。表涨到几十万行后每一批都要扫全表。
   * - `refresh_tokens` 的回收按 expires_time 过滤，同理走不了
   *   `idx_rt_user (user_id, revoked_time, expires_time)`。
   * - `subscriptions` 的到期降级是 `WHERE status = 'active' AND
   *   period_end_time <= ?`，此前只有 `uq_sub_user (user_id)`，全表扫。
   *   定时任务扫全表还能忍，但 expireOne 挂在 /api/me 上。
   *
   * 全部走 addIndexIfMissing：新库在 CREATE TABLE 时没带这些索引（保持建表
   * 语句可读），老库也要能补上，两边统一从这里加。
   */
  await addIndexIfMissing(mysql, 'sync_events', 'idx_se_time', 'KEY `idx_se_time` (create_time)', app.log);
  await addIndexIfMissing(mysql, 'usage_events', 'idx_ue_time', 'KEY `idx_ue_time` (create_time)', app.log);
  await addIndexIfMissing(mysql, 'device_events', 'idx_de_time', 'KEY `idx_de_time` (create_time)', app.log);
  await addIndexIfMissing(mysql, 'refresh_tokens', 'idx_rt_expires', 'KEY `idx_rt_expires` (expires_time)', app.log);
  await addIndexIfMissing(
    mysql,
    'subscriptions',
    'idx_sub_status_period',
    'KEY `idx_sub_status_period` (status, period_end_time)',
    app.log,
  );

  // plans 数据播种
  await seedPlans(mysql);
}

/** 只用到 error 级别；FastifyBaseLogger 与 console 都满足 */
type MinimalLogger = { error: (msg: string) => void };

/**
 * 幂等加索引。MySQL 没有 `ADD INDEX IF NOT EXISTS`，靠错误码区分三种结果：
 *
 * - ER_DUP_KEYNAME(1061)：索引已存在 → 正常，什么都不做。
 * - ER_DUP_ENTRY(1062)：表里已有违反唯一性的数据 → **记错误日志并继续**。
 * - 其他错误 → 抛出，让启动失败。
 *
 * 为什么 1062 不抛：`initSchema` 跑在服务启动路径上。一次历史脏数据把服务
 * 永久钉死在起不来的状态，比「少一条唯一性保证但服务在跑」严重得多。
 * 日志里带上去重 SQL，让运维能自己收尾。
 */
export async function addIndexIfMissing(
  mysql: { query: (sql: string, p?: any[]) => Promise<any> },
  table: string,
  indexName: string,
  definition: string,
  log?: MinimalLogger,
): Promise<void> {
  try {
    await mysql.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  } catch (err: any) {
    if (err?.code === 'ER_DUP_KEYNAME' || err?.errno === 1061) return;
    if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
      log?.error(
        `[schema] 无法为 ${table} 建立索引 ${indexName}：表内已有重复数据。` +
        `服务继续启动，但该唯一性约束缺失。请先人工去重后重启，` +
        `例如：DELETE t FROM ${table} t JOIN ${table} k ON <唯一列相同> AND t.id > k.id;`,
      );
      return;
    }
    throw err;
  }
}

/** 幂等加列：列不存在才 ADD（MySQL 无 IF NOT EXISTS 语法，靠错误码兼容） */
async function addColumnIfMissing(
  mysql: { query: (sql: string, p?: any[]) => Promise<any> },
  table: string,
  column: string,
  def: string,
): Promise<void> {
  try {
    await mysql.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
  } catch (err: any) {
    // ER_DUP_FIELDNAME(1060)：列已存在
    if (err?.code !== 'ER_DUP_FIELDNAME' && err?.errno !== 1060) throw err;
  }
}

interface PlanSeed {
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number;
  maxDevices: number;
  maxConnections: number;
  syncQuotaBytes: number;
  syncVersionRetention: number;
  historyRetentionCount: number;
  features: number;
}

const PLAN_SEED: PlanSeed[] = [
  {
    code: 'free', name: 'Free', priceMonth: 0, priceYear: 0,
    maxDevices: 1, maxConnections: 5, syncQuotaBytes: 1 * 1024 * 1024,
    syncVersionRetention: 3, historyRetentionCount: 50, features: 1,
  },
  {
    code: 'pro', name: 'Pro', priceMonth: 5, priceYear: 60,
    maxDevices: 5, maxConnections: 50, syncQuotaBytes: 100 * 1024 * 1024,
    syncVersionRetention: 30, historyRetentionCount: 0, features: 0b111,
  },
  {
    code: 'team', name: 'Team', priceMonth: 20, priceYear: 200,
    maxDevices: 20, maxConnections: 500, syncQuotaBytes: 1024 * 1024 * 1024,
    syncVersionRetention: 90, historyRetentionCount: 0, features: 0b111111,
  },
];

async function seedPlans(mysql: { query: (sql: string, p?: any[]) => Promise<any> }): Promise<void> {
  for (const p of PLAN_SEED) {
    // 仅首次创建；已存在的套餐不覆盖任何字段（价格/配额改由管理后台编辑，避免重启重置）。
    await mysql.query(
      `INSERT INTO plans (code, name, price_month, price_year, max_devices, max_connections, sync_quota_bytes, sync_version_retention, history_retention_count, features)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE code = VALUES(code)`,
      [p.code, p.name, p.priceMonth, p.priceYear, p.maxDevices, p.maxConnections, p.syncQuotaBytes, p.syncVersionRetention, p.historyRetentionCount, p.features],
    );
  }
}
