import { describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { initSchema } from '../../src/repository/mysql/schema.js';
import { MysqlSyncRepo } from '../../src/repository/mysql/syncRepo.js';
import { resolveTestDb, parseMysqlUrl } from './testDb.js';

/**
 * 真实 MySQL（独立测试库 dbclient_verify）上的 server 持久化行为验证。
 *
 * 所有写入都发生在测试库内新建的表，结束后 DROP TABLE 清理，绝不触碰
 * 已有业务对象。门禁：MYSQL_TEST_URL（密码须百分号编码），未设置整个跳过。
 */
const URL = process.env.MYSQL_TEST_URL;

// 门禁只在真要连库时求值：URL 未设置时整体 skip，不能因环境变量让文件失败
const DB_NAME = URL ? resolveTestDb() : 'skipped';

describe.skipIf(!URL)('MySQL initSchema + syncRepo (isolated test db)', () => {
  let pool: ReturnType<typeof createPool> | undefined;

  async function freshPool() {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    pool = createPool({ host, port, user, password, database: DB_NAME, waitForConnections: true, connectionLimit: 5 });
    return pool;
  }

  it('initSchema 幂等：连续两轮建表 + 播种不报错，表结构符合预期', async () => {
    await freshPool();
    const fakeApp = { mysql: pool } as any;

    await initSchema(fakeApp);
    await initSchema(fakeApp); // 第二遍必须幂等

    const [tables]: any[] = await pool!.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
      [DB_NAME],
    );
    const names = tables.map((t: any) => t.TABLE_NAME);
    // 全部 15 张表都要断言。此前只列了 6 张，于是后来新增的 9 张（设备、
    // 连接元数据、事件流、流量统计、限流规则）的 DDL 在真实 MySQL 上从未验证过 ——
    // 语法错误只会在生产启动 initSchema 时才炸。
    for (const expected of [
      'plans', 'users', 'subscriptions', 'refresh_tokens',
      'devices', 'device_events', 'connection_meta',
      'sync_events', 'usage_events',
      'sync_sections', 'sync_section_versions',
      'traffic_stats', 'traffic_blocked',
      'rate_limit_rules', 'rate_limit_allowlist',
    ]) {
      expect(names, `缺表 ${expected}`).toContain(expected);
    }

    const [plans]: any[] = await pool!.query('SELECT code FROM plans ORDER BY code');
    expect(plans.map((p: any) => p.code)).toEqual(['free', 'pro', 'team']);
    await pool!.end(); pool = undefined;
  });

  it('syncRepo.putSectionIfVersion：基线对接后写入成功并版本自增', async () => {
    await freshPool();
    // FK: sync_sections.user_id → users.id CASCADE。隔离用户，绝不触碰已有行
    const isoEmail = `verify-${Date.now()}@dbclient.dev`;
    const [ins]: any[] = await pool!.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [isoEmail, 'not-used-hash'],
    );
    const isoUserId = ins.insertId as number;

    const repo = new MysqlSyncRepo(() => pool as any);
    const v1 = await repo.putSectionIfVersion(isoUserId, 'connections' as any, 'ENCRYPTED-A', 0);
    expect(v1).toBe(1);
    const v2 = await repo.putSectionIfVersion(isoUserId, 'connections' as any, 'ENCRYPTED-B', v1!);
    expect(v2).toBe(2);
    const [rows]: any[] = await pool!.query(
      'SELECT version, encrypted_data FROM sync_sections WHERE user_id = ? AND section = ?',
      [isoUserId, 'connections'],
    );
    expect(rows[0]).toEqual({ version: 2, encrypted_data: 'ENCRYPTED-B' });

    // 清理本次写入的行与隔离用户（表本身留给下一轮用例）
    await pool!.query('DELETE FROM sync_sections WHERE user_id = ?', [isoUserId]);
    await pool!.query('DELETE FROM users WHERE id = ?', [isoUserId]);
    await pool!.end(); pool = undefined;
  });

  /**
   * 乐观锁的冲突判定（此前是缺陷，现已修复）。
   *
   * 旧实现用「一条 INSERT ... ON DUPLICATE KEY UPDATE + 回读 version 与 base+1
   * 比较」来判断成败，在 **base = 当前版本 - 1** 时会误判成功：条件更新没匹配上，
   * version 保持为 V，而 base+1 恰好等于 V，回读比较通过。
   *
   * 而 base = V-1 正是两台设备先后推送时后一台的处境 —— 于是它的数据没写进去、
   * 却被告知成功，客户端记下新版本号并标记已同步，本地修改被静默丢弃。
   *
   * 这条用例此前断言的是错误行为（`expect(v2).toBe(1)` 并注明「缺陷的体现」）。
   * 假实现 FakeSyncRepo 当时比真实现严格，把这个洞在单测里盖住了，只有真实
   * MySQL 才能暴露 —— 所以这里必须留一条真库用例守着。
   */
  it('乐观锁：落后一个版本的 base 必须判为冲突（不能静默丢数据）', async () => {
    await freshPool();
    const [ins]: any[] = await pool!.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [`verify-conflict-${Date.now()}@dbclient.dev`, 'not-used-hash'],
    );
    const uid = ins.insertId as number;
    const repo = new MysqlSyncRepo(() => pool as any);

    // 首次写入：base=0 成功，version → 1
    expect(await repo.putSectionIfVersion(uid, 'queries' as any, 'DATA-A', 0)).toBe(1);
    // 正常推进：base=1 成功，version → 2
    expect(await repo.putSectionIfVersion(uid, 'queries' as any, 'DATA-B', 1)).toBe(2);

    // 落后一版（base=1，当前已是 2）→ 必须冲突
    expect(await repo.putSectionIfVersion(uid, 'queries' as any, 'STALE', 1)).toBeNull();
    // 落后两版同样冲突
    expect(await repo.putSectionIfVersion(uid, 'queries' as any, 'STALE', 0)).toBeNull();
    // 超前的 base 也不许
    expect(await repo.putSectionIfVersion(uid, 'queries' as any, 'AHEAD', 9)).toBeNull();

    // 冲突不能污染数据：内容与版本都停在成功的那一次
    const [rows]: any[] = await pool!.query(
      'SELECT version, encrypted_data FROM sync_sections WHERE user_id = ? AND section = ?',
      [uid, 'queries'],
    );
    expect(rows[0]).toEqual({ version: 2, encrypted_data: 'DATA-B' });

    await pool!.query('DELETE FROM sync_sections WHERE user_id = ?', [uid]);
    await pool!.query('DELETE FROM users WHERE id = ?', [uid]);
    await pool!.end(); pool = undefined;
  });

  /**
   * 首次写入（行不存在）必须从 base=0 开始。
   * 旧实现走 INSERT 分支时完全不校验 base，`base=5` 能凭空造出 version=6 的行。
   */
  it('乐观锁：行不存在时只接受 base=0', async () => {
    await freshPool();
    const [ins]: any[] = await pool!.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [`verify-first-${Date.now()}@dbclient.dev`, 'not-used-hash'],
    );
    const uid = ins.insertId as number;
    const repo = new MysqlSyncRepo(() => pool as any);

    // 行不存在 + base>0 → 冲突，且不留下任何行
    expect(await repo.putSectionIfVersion(uid, 'history' as any, 'DATA-C', 5)).toBeNull();
    const [none]: any[] = await pool!.query(
      'SELECT COUNT(*) AS c FROM sync_sections WHERE user_id = ? AND section = ?',
      [uid, 'history'],
    );
    expect(Number(none[0].c)).toBe(0);

    // base=0 才能开张
    expect(await repo.putSectionIfVersion(uid, 'history' as any, 'DATA-C', 0)).toBe(1);

    await pool!.query('DELETE FROM sync_sections WHERE user_id = ?', [uid]);
    await pool!.query('DELETE FROM users WHERE id = ?', [uid]);
    await pool!.end(); pool = undefined;
  });

  /**
   * 并发推送同一个新 section：唯一键 uq_ss_user_section 必须让其中一个失败，
   * 而不是抛 ER_DUP_ENTRY 给上层变成 500。
   */
  it('乐观锁：并发首次写入只有一个成功，另一个判冲突而非报错', async () => {
    await freshPool();
    const [ins]: any[] = await pool!.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [`verify-race-${Date.now()}@dbclient.dev`, 'not-used-hash'],
    );
    const uid = ins.insertId as number;
    const repo = new MysqlSyncRepo(() => pool as any);

    const results = await Promise.all([
      repo.putSectionIfVersion(uid, 'folders' as any, 'A', 0),
      repo.putSectionIfVersion(uid, 'folders' as any, 'B', 0),
    ]);
    const ok = results.filter((r) => r !== null);
    expect(ok).toHaveLength(1);
    expect(ok[0]).toBe(1);

    await pool!.query('DELETE FROM sync_sections WHERE user_id = ?', [uid]);
    await pool!.query('DELETE FROM users WHERE id = ?', [uid]);
    await pool!.end(); pool = undefined;
  });
}, 30_000);