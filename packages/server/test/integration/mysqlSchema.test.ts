import { describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { initSchema } from '../../src/repository/mysql/schema.js';
import { MysqlSyncRepo } from '../../src/repository/mysql/syncRepo.js';

/**
 * 真实 MySQL（独立测试库 dbclient_verify）上的 server 持久化行为验证。
 *
 * 所有写入都发生在测试库内新建的表，结束后 DROP TABLE 清理，绝不触碰
 * 已有业务对象。门禁：MYSQL_TEST_URL（密码须百分号编码），未设置整个跳过。
 */
const URL = process.env.MYSQL_TEST_URL;

function hostFrom(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`bad MYSQL_TEST_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return { host, port: port ? Number(port) : 3306, user: decodeURIComponent(user), password: decodeURIComponent(encPwd) };
}

const DB_NAME = 'dbclient_verify';

describe.skipIf(!URL)('MySQL initSchema + syncRepo (isolated test db)', () => {
  let pool: ReturnType<typeof createPool> | undefined;

  async function freshPool() {
    const { host, port, user, password } = hostFrom(URL!);
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
    for (const expected of ['plans', 'users', 'subscriptions', 'refresh_tokens', 'personal_access_tokens', 'sync_sections', 'sync_section_versions']) {
      expect(names).toContain(expected);
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
   * 缺陷证实（不修复）：乐观锁在**行不存在**时对任何 baseVersion 都放行。
   * syncRepo.putSectionIfVersion 用 `INSERT ... ON DUPLICATE KEY UPDATE`，
   * 行不存在时走 INSERT 分支，version = base+1 照写，不校验 base 是否已被
   * 其他人推进——FakeSyncRepo 却严格要求 curVersion === baseVersion，
   * 假实现比真实实现严格，测试因此覆盖不到这个洞。
   * 这里实测真实行为，供后续修复参考。
   */
  it('缺陷证实：行不存在时传入过期 baseVersion 也会写入成功', async () => {
    await freshPool();
    const [ins]: any[] = await pool!.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [`verify-conflict-${Date.now()}@dbclient.dev`, 'not-used-hash'],
    );
    const uid = ins.insertId as number;
    const repo = new MysqlSyncRepo(() => pool as any);

    // 第一次写入：base=0 成功
    const v1 = await repo.putSectionIfVersion(uid, 'queries' as any, 'DATA-A', 0);
    expect(v1).toBe(1);

    // 缺陷：以过期 base=0 再推，行已存在但 version 已是 1。
    // ON DUPLICATE KEY 走 UPDATE，IF(version=0,...) 不匹配 → 数据不变、version 不变，
    // 回读 version(1) === newVersion(1) → 误判成功（正确应为 null = 冲突）。
    const v2 = await repo.putSectionIfVersion(uid, 'queries' as any, 'DATA-B', 0);
    expect(v2).toBe(1); // ← 缺陷的体现：过期 base 被判定成功了

    // 行不存在时 + 过期 base：base=5（>0）也会 INSERT 成功
    const v3 = await repo.putSectionIfVersion(uid, 'history' as any, 'DATA-C', 5);
    expect(v3).toBe(6); // ← 行不存在时任何 base 都放行

    await pool!.query('DELETE FROM sync_sections WHERE user_id = ?', [uid]);
    await pool!.query('DELETE FROM users WHERE id = ?', [uid]);
    await pool!.end(); pool = undefined;
  });
}, 30_000);