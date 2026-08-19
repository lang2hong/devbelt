import { describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { initSchema, addIndexIfMissing } from '../../src/repository/mysql/schema.js';
import { MysqlSyncRepo } from '../../src/repository/mysql/syncRepo.js';
import { MysqlConnectionMetaRepo } from '../../src/repository/mysql/connectionMetaRepo.js';
import { resolveTestDb, parseMysqlUrl } from './testDb.js';

/**
 * 真实 MySQL 上的事务与唯一键验证（独立测试库 dbclient_verify）。
 *
 * 事务语义、唯一键冲突、并发下的 affectedRows —— 这三样在内存桩里全是我们
 * 自己写的假设。桩能守住分支逻辑，但守不住「MySQL 到底怎么表现」。
 * 门禁：MYSQL_TEST_URL 未设置整个跳过。
 */
const URL = process.env.MYSQL_TEST_URL;
// 门禁只在真要连库时求值：URL 未设置时整体 skip，不能因环境变量让文件失败
const DB_NAME = URL ? resolveTestDb() : 'skipped';

describe.skipIf(!URL)('MySQL 事务与唯一键（isolated test db）', () => {
  async function freshPool() {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    return createPool({ host, port, user, password, database: DB_NAME, waitForConnections: true, connectionLimit: 8 });
  }

  async function isoUser(pool: any, tag: string): Promise<number> {
    const [ins]: any = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [`tx-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@dbclient.dev`, 'not-used-hash'],
    );
    return ins.insertId as number;
  }

  async function cleanup(pool: any, uid: number) {
    await pool.query('DELETE FROM sync_section_versions WHERE user_id = ?', [uid]);
    await pool.query('DELETE FROM sync_sections WHERE user_id = ?', [uid]);
    await pool.query('DELETE FROM connection_meta WHERE user_id = ?', [uid]);
    await pool.query('DELETE FROM users WHERE id = ?', [uid]);
  }

  it('initSchema 为 sync_section_versions 建出唯一键 (user_id, section, version)', async () => {
    const pool = await freshPool();
    try {
      await initSchema({ mysql: pool, log: console } as any);
      const [idx]: any = await pool.query('SHOW INDEX FROM sync_section_versions');
      const uq = idx.filter((i: any) => i.Key_name === 'uq_sv_user_section');
      expect(uq, '缺唯一键 uq_sv_user_section').not.toHaveLength(0);
      expect(uq.every((i: any) => i.Non_unique === 0)).toBe(true);
      expect(uq.sort((a: any, b: any) => a.Seq_in_index - b.Seq_in_index).map((i: any) => i.Column_name))
        .toEqual(['user_id', 'section', 'version']);
      // 幂等：再跑一遍不能因为索引已存在而报错
      await initSchema({ mysql: pool, log: console } as any);
    } finally {
      await pool.end();
    }
  });

  it('唯一键存在时，同一版本号重复记快照只会覆盖，不会多出一行', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'dupver');
    try {
      const repo = new MysqlSyncRepo(() => pool as any);
      await repo.recordVersion(uid, 'groups' as any, 1, 'FIRST', 5);
      await repo.recordVersion(uid, 'groups' as any, 1, 'SECOND', 6);
      const [rows]: any = await pool.query(
        'SELECT encrypted_data, data_bytes FROM sync_section_versions WHERE user_id = ? AND section = ?',
        [uid, 'groups'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ encrypted_data: 'SECOND', data_bytes: 6 });
    } finally {
      await cleanup(pool, uid);
      await pool.end();
    }
  });

  it('pushSection：当前版本与历史快照同事务落盘', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'push');
    try {
      const repo = new MysqlSyncRepo(() => pool as any);
      expect(await repo.pushSection(uid, 'queries' as any, 'P1', 0, 2)).toBe(1);
      expect(await repo.pushSection(uid, 'queries' as any, 'P2', 1, 2)).toBe(2);
      expect(await repo.pushSection(uid, 'queries' as any, 'STALE', 1, 5)).toBeNull();

      const [cur]: any = await pool.query(
        'SELECT version, encrypted_data FROM sync_sections WHERE user_id = ? AND section = ?',
        [uid, 'queries'],
      );
      expect(cur[0]).toEqual({ version: 2, encrypted_data: 'P2' });
      const [hist]: any = await pool.query(
        'SELECT version, encrypted_data FROM sync_section_versions WHERE user_id = ? AND section = ? ORDER BY version',
        [uid, 'queries'],
      );
      expect(hist.map((h: any) => h.version)).toEqual([1, 2]);
    } finally {
      await cleanup(pool, uid);
      await pool.end();
    }
  });

  /**
   * 并发回滚是旧实现最脏的一处：`rollback` 读出 current=V 后用无条件 upsert
   * 写 V+1，两个并发请求都读到 V、都写 V+1 —— 一方的写入被另一方覆盖，
   * 两方都被告知「回滚成功，新版本 V+1」，历史表还会多出一条同版本号的行。
   */
  it('并发回滚：不产生相同的新版本号，历史表无重复版本', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'rbrace');
    try {
      const repo = new MysqlSyncRepo(() => pool as any);
      await repo.pushSection(uid, 'folders' as any, 'R1', 0, 2);
      await repo.pushSection(uid, 'folders' as any, 'R2', 1, 2);

      // 并发度开到 6：真实交错靠调度，两个请求未必撞上，多几个才稳定复现
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => repo.rollback(uid, 'folders' as any, 1)),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').map((r: any) => r.value);
      // 成功的那些必须各自拿到不同的版本号
      expect(new Set(ok).size).toBe(ok.length);
      expect(ok.length).toBeGreaterThanOrEqual(1);

      const [dup]: any = await pool.query(
        `SELECT version, COUNT(*) c FROM sync_section_versions
          WHERE user_id = ? AND section = ? GROUP BY version HAVING c > 1`,
        [uid, 'folders'],
      );
      expect(dup, '历史表出现重复版本号').toHaveLength(0);

      const [cur]: any = await pool.query(
        'SELECT version FROM sync_sections WHERE user_id = ? AND section = ?',
        [uid, 'folders'],
      );
      expect(cur[0].version).toBe(Math.max(...ok));
    } finally {
      await cleanup(pool, uid);
      await pool.end();
    }
  });

  it('replaceAll 在真库事务内完成全量替换：未上报行置墓碑', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'meta');
    try {
      const repo = new MysqlConnectionMetaRepo(() => pool as any);
      const mk = (u: string) => ({ connUuid: u, type: 'mysql', name: u, enabled: true, deleted: false });
      expect(await repo.replaceAll(uid, [mk('a'), mk('b'), mk('c')])).toBe(3);
      expect(await repo.replaceAll(uid, [mk('a')])).toBe(1);
      const [rows]: any = await pool.query(
        'SELECT conn_uuid, deleted FROM connection_meta WHERE user_id = ? ORDER BY conn_uuid',
        [uid],
      );
      expect(rows.map((r: any) => [r.conn_uuid, r.deleted])).toEqual([['a', 0], ['b', 1], ['c', 1]]);
    } finally {
      await cleanup(pool, uid);
      await pool.end();
    }
  });

  /**
   * 已有重复数据的库上加唯一键会失败（ER_DUP_ENTRY）。启动流程不能因此崩掉 ——
   * 那等于让一次历史脏数据把服务锁死在起不来的状态。
   */
  it('addIndexIfMissing：表中已有重复数据时不抛错，只记日志', async () => {
    const pool = await freshPool();
    const tmp = `tmp_uqtest_${Date.now()}`;
    const warns: string[] = [];
    try {
      await pool.query(`CREATE TABLE \`${tmp}\` (id INT AUTO_INCREMENT PRIMARY KEY, a INT NOT NULL)`);
      await pool.query(`INSERT INTO \`${tmp}\` (a) VALUES (1), (1)`);
      await addIndexIfMissing(
        pool as any,
        tmp,
        'uq_tmp_a',
        'UNIQUE KEY `uq_tmp_a` (a)',
        { error: (m: string) => warns.push(m), warn: (m: string) => warns.push(m) } as any,
      );
      expect(warns.join('\n')).toMatch(/uq_tmp_a/);
      const [idx]: any = await pool.query(`SHOW INDEX FROM \`${tmp}\``);
      expect(idx.some((i: any) => i.Key_name === 'uq_tmp_a')).toBe(false);

      // 去重后再加一次必须成功，且第三次调用（索引已存在）幂等
      await pool.query(`DELETE FROM \`${tmp}\` WHERE id NOT IN (SELECT MIN(id) FROM (SELECT id, a FROM \`${tmp}\`) t GROUP BY a)`);
      await addIndexIfMissing(pool as any, tmp, 'uq_tmp_a', 'UNIQUE KEY `uq_tmp_a` (a)');
      await addIndexIfMissing(pool as any, tmp, 'uq_tmp_a', 'UNIQUE KEY `uq_tmp_a` (a)');
      const [idx2]: any = await pool.query(`SHOW INDEX FROM \`${tmp}\``);
      expect(idx2.filter((i: any) => i.Key_name === 'uq_tmp_a')).toHaveLength(1);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS \`${tmp}\``);
      await pool.end();
    }
  });
}, 40_000);
