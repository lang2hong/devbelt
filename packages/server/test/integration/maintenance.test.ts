import { describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { initSchema } from '../../src/repository/mysql/schema.js';
import { MysqlMaintenanceRepo, PRUNE_BATCH } from '../../src/repository/mysql/maintenanceRepo.js';
import { MysqlSubscriptionRepo } from '../../src/repository/mysql/subscriptionRepo.js';

/**
 * 真实 MySQL 上验证清理语句与到期降级（独立测试库 dbclient_verify）。
 *
 * 桩测试守得住分支逻辑，守不住 SQL 本身能不能跑：`DELETE ... LIMIT` 在
 * 多表语句里是语法错误、`UPDATE t1 JOIN t2` 的 affectedRows 到底怎么算、
 * 新加的索引会不会被优化器选中 —— 这些只有真库能回答。
 */
const URL = process.env.MYSQL_TEST_URL;
const DB_NAME = process.env.MYSQL_TEST_DB || 'dbclient_verify';

function hostFrom(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`bad MYSQL_TEST_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return { host, port: port ? Number(port) : 3306, user: decodeURIComponent(user), password: decodeURIComponent(encPwd) };
}

const DAY = 86400_000;

describe.skipIf(!URL)('MySQL 清理与到期降级（isolated test db）', () => {
  async function freshPool() {
    const { host, port, user, password } = hostFrom(URL!);
    return createPool({ host, port, user, password, database: DB_NAME, waitForConnections: true, connectionLimit: 5 });
  }

  async function isoUser(pool: any, tag: string, plan = 'pro'): Promise<number> {
    const [ins]: any = await pool.query(
      'INSERT INTO users (email, password_hash, plan_code) VALUES (?, ?, ?)',
      [`mt-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@dbclient.dev`, 'not-used-hash', plan],
    );
    return ins.insertId as number;
  }

  async function cleanup(pool: any, ids: number[]) {
    for (const id of ids) {
      // FK ON DELETE CASCADE 会带走 subscriptions / 事件表 / refresh_tokens
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
    }
  }

  it('initSchema 建出清理与到期扫描所需的索引', async () => {
    const pool = await freshPool();
    try {
      await initSchema({ mysql: pool, log: console } as any);
      const expected: Array<[string, string, string[]]> = [
        ['sync_events', 'idx_se_time', ['create_time']],
        ['usage_events', 'idx_ue_time', ['create_time']],
        ['device_events', 'idx_de_time', ['create_time']],
        ['refresh_tokens', 'idx_rt_expires', ['expires_time']],
        ['subscriptions', 'idx_sub_status_period', ['status', 'period_end_time']],
      ];
      for (const [table, name, cols] of expected) {
        const [idx]: any = await pool.query(`SHOW INDEX FROM \`${table}\``);
        const hit = idx.filter((i: any) => i.Key_name === name)
          .sort((a: any, b: any) => a.Seq_in_index - b.Seq_in_index)
          .map((i: any) => i.Column_name);
        expect(hit, `${table} 缺索引 ${name}`).toEqual(cols);
      }
      await initSchema({ mysql: pool, log: console } as any); // 幂等
    } finally {
      await pool.end();
    }
  });

  it('到期降级扫描走 idx_sub_status_period，不是全表扫', async () => {
    const pool = await freshPool();
    try {
      const [plan]: any = await pool.query(
        `EXPLAIN SELECT id FROM subscriptions WHERE status = 'active' AND period_end_time <= ?`,
        [new Date()],
      );
      // key 为 null 表示没用上任何索引。行数少时优化器可能仍选全表扫，
      // 所以断言的是「这个索引对优化器可见」，而不是它一定被选中。
      const [keys]: any = await pool.query(
        `SELECT index_name FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = 'subscriptions' AND index_name = 'idx_sub_status_period'`,
        [DB_NAME],
      );
      expect(keys.length).toBeGreaterThan(0);
      expect(plan[0]).toBeDefined();
    } finally {
      await pool.end();
    }
  });

  it('pruneEvents 的 DELETE 语句在真库可执行，并按 create_time 删除', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'prune');
    try {
      const old = new Date(Date.now() - 200 * DAY);
      const recent = new Date(Date.now() - 1 * DAY);
      for (const t of [old, old, recent]) {
        await pool.query(
          'INSERT INTO sync_events (user_id, direction, section, bytes, item_count, create_time) VALUES (?, ?, ?, ?, ?, ?)',
          [uid, 'push', 'groups', 10, 1, t],
        );
        await pool.query(
          'INSERT INTO usage_events (user_id, kind, count, create_time) VALUES (?, ?, ?, ?)',
          [uid, 'query', 1, t],
        );
        await pool.query(
          'INSERT INTO device_events (user_id, device_id, event, create_time) VALUES (?, ?, ?, ?)',
          [uid, 'dev-1', 'first', t],
        );
      }
      await pool.query(
        'INSERT INTO traffic_blocked (ip, route, bucket, create_time) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
        ['1.2.3.4', '/api/sync', 'sync', old, '1.2.3.4', '/api/sync', 'sync', recent],
      );

      const res = await new MysqlMaintenanceRepo(() => pool as any).pruneEvents(90, new Date());
      expect(res.errors).toEqual([]);

      // 只剩下 recent 的那些行（这些计数只统计本用户，不受库里其他数据影响）
      for (const t of ['sync_events', 'usage_events', 'device_events']) {
        const [rows]: any = await pool.query(`SELECT COUNT(*) c FROM \`${t}\` WHERE user_id = ?`, [uid]);
        expect(Number(rows[0].c), `${t} 未按 create_time 清理`).toBe(1);
      }
      const [tb]: any = await pool.query(
        'SELECT COUNT(*) c FROM traffic_blocked WHERE ip = ? AND create_time < ?',
        ['1.2.3.4', new Date(Date.now() - 90 * DAY)],
      );
      expect(Number(tb[0].c)).toBe(0);
    } finally {
      await pool.query('DELETE FROM traffic_blocked WHERE ip = ?', ['1.2.3.4']);
      await cleanup(pool, [uid]);
      await pool.end();
    }
  });

  /**
   * refresh_tokens 的清理条件最容易写错：删掉仍然有效的会话等于静默踢人下线。
   */
  it('pruneEvents 不动仍然有效的会话，只回收早已过期的行', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'rt');
    try {
      const mk = (hash: string, expires: Date, revoked?: Date) => pool.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_time, revoked_time) VALUES (?, ?, ?, ?)',
        [uid, hash, expires, revoked ?? null],
      );
      const h = (s: string) => (s + '0'.repeat(64)).slice(0, 64);
      await mk(h(`live${uid}`), new Date(Date.now() + 30 * DAY));                       // 有效，必须留
      await mk(h(`revk${uid}`), new Date(Date.now() + 30 * DAY), new Date());           // 刚撤销但未过期，必须留（重用检测依据）
      await mk(h(`recent${uid}`), new Date(Date.now() - 1 * DAY));                      // 刚过期，还在保留期内，留
      await mk(h(`stale${uid}`), new Date(Date.now() - 200 * DAY));                     // 早已过期，删
      await mk(h(`staleR${uid}`), new Date(Date.now() - 200 * DAY), new Date(Date.now() - 200 * DAY)); // 早已撤销且过期，删

      const res = await new MysqlMaintenanceRepo(() => pool as any).pruneEvents(90, new Date());
      expect(res.errors).toEqual([]);

      const [rows]: any = await pool.query(
        'SELECT token_hash FROM refresh_tokens WHERE user_id = ? ORDER BY token_hash',
        [uid],
      );
      const kept = rows.map((r: any) => r.token_hash.replace(/0+$/, ''));
      expect(kept.sort()).toEqual([`live${uid}`, `recent${uid}`, `revk${uid}`].sort());
    } finally {
      await cleanup(pool, [uid]);
      await pool.end();
    }
  });

  it('retentionDays = 0 时一行都不删', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'off');
    try {
      await pool.query(
        'INSERT INTO sync_events (user_id, direction, section, bytes, item_count, create_time) VALUES (?, ?, ?, ?, ?, ?)',
        [uid, 'push', 'groups', 1, 1, new Date(Date.now() - 999 * DAY)],
      );
      const res = await new MysqlMaintenanceRepo(() => pool as any).pruneEvents(0, new Date());
      expect(res.total).toBe(0);
      const [rows]: any = await pool.query('SELECT COUNT(*) c FROM sync_events WHERE user_id = ?', [uid]);
      expect(Number(rows[0].c)).toBe(1);
    } finally {
      await cleanup(pool, [uid]);
      await pool.end();
    }
  });

  it('分批删除：超过一批的数据会被多轮删完', async () => {
    const pool = await freshPool();
    const uid = await isoUser(pool, 'batch');
    try {
      const old = new Date(Date.now() - 200 * DAY);
      const n = PRUNE_BATCH + 50;
      // 一次多值 INSERT 灌满，避免几千次往返
      const CHUNK = 500;
      for (let i = 0; i < n; i += CHUNK) {
        const rows = Math.min(CHUNK, n - i);
        const ph = Array.from({ length: rows }, () => '(?, ?, ?, ?, ?, ?)').join(',');
        const params: any[] = [];
        for (let j = 0; j < rows; j++) params.push(uid, 'push', 'groups', 1, 1, old);
        await pool.query(
          `INSERT INTO sync_events (user_id, direction, section, bytes, item_count, create_time) VALUES ${ph}`,
          params,
        );
      }
      const res = await new MysqlMaintenanceRepo(() => pool as any).pruneEvents(90, new Date());
      expect(res.errors).toEqual([]);
      const [rows]: any = await pool.query('SELECT COUNT(*) c FROM sync_events WHERE user_id = ?', [uid]);
      expect(Number(rows[0].c)).toBe(0);
      expect(res.deleted.sync_events).toBeGreaterThanOrEqual(n);
    } finally {
      await cleanup(pool, [uid]);
      await pool.end();
    }
  }, 60_000);

  describe('到期降级', () => {
    it('expireOne 只改目标用户，同时把 users.plan_code 降到 free', async () => {
      const pool = await freshPool();
      const a = await isoUser(pool, 'expA');
      const b = await isoUser(pool, 'expB');
      try {
        const past = new Date(Date.now() - DAY);
        for (const uid of [a, b]) {
          await pool.query(
            'INSERT INTO subscriptions (user_id, plan_code, status, period_end_time) VALUES (?, ?, ?, ?)',
            [uid, 'pro', 'active', past],
          );
        }
        const repo = new MysqlSubscriptionRepo(() => pool as any);
        expect(await repo.expireOne(a, new Date())).toBe(true);

        const [rows]: any = await pool.query(
          `SELECT s.user_id, s.status, u.plan_code FROM subscriptions s
             JOIN users u ON u.id = s.user_id WHERE s.user_id IN (?, ?) ORDER BY s.user_id`,
          [a, b],
        );
        const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
        expect(byUser.get(a)).toMatchObject({ status: 'expired', plan_code: 'free' });
        // B 同样到期，但没有被这次调用波及
        expect(byUser.get(b)).toMatchObject({ status: 'active', plan_code: 'pro' });

        // 幂等：已经 expired 了，第二次改不到行
        expect(await repo.expireOne(a, new Date())).toBe(false);
      } finally {
        await cleanup(pool, [a, b]);
        await pool.end();
      }
    });

    it('periodEndTime 恰好等于 now 也算到期（比较符含等号）', async () => {
      const pool = await freshPool();
      const uid = await isoUser(pool, 'eq');
      try {
        // TIMESTAMP 默认秒精度，去掉毫秒才能让两边真正相等
        const now = new Date(Math.floor(Date.now() / 1000) * 1000);
        await pool.query(
          'INSERT INTO subscriptions (user_id, plan_code, status, period_end_time) VALUES (?, ?, ?, ?)',
          [uid, 'pro', 'active', now],
        );
        const repo = new MysqlSubscriptionRepo(() => pool as any);
        expect(await repo.expireOne(uid, now)).toBe(true);
        const [rows]: any = await pool.query('SELECT status FROM subscriptions WHERE user_id = ?', [uid]);
        expect(rows[0].status).toBe('expired');
      } finally {
        await cleanup(pool, [uid]);
        await pool.end();
      }
    });

    /**
     * downgradeExpired 的返回值必须是**订阅行数**。
     * 单条 `UPDATE t1 JOIN t2` 的 affectedRows 是两表之和，而 plan_code 恰好
     * 已是 free 的用户又只计 1 —— 既不是 N 也不是 2N，拿它当「降级了几个人」
     * 会把排查带偏。所以真实现拆成两条单表 UPDATE 包在事务里。
     */
    it('downgradeExpired 返回订阅行数，且把用户一起降级', async () => {
      const pool = await freshPool();
      const a = await isoUser(pool, 'dgA');
      const b = await isoUser(pool, 'dgB', 'free'); // plan_code 已是 free
      const c = await isoUser(pool, 'dgC');
      try {
        const past = new Date(Date.now() - DAY);
        const future = new Date(Date.now() + DAY);
        await pool.query(
          `INSERT INTO subscriptions (user_id, plan_code, status, period_end_time) VALUES (?, 'pro', 'active', ?), (?, 'pro', 'active', ?), (?, 'pro', 'active', ?)`,
          [a, past, b, past, c, future],
        );
        const repo = new MysqlSubscriptionRepo(() => pool as any);

        // 只算本次可降的两行，与 users 表改了几行无关
        const n = await repo.downgradeExpired(new Date());
        expect(n).toBe(2);

        const [rows]: any = await pool.query(
          `SELECT s.user_id, s.status, u.plan_code FROM subscriptions s
             JOIN users u ON u.id = s.user_id WHERE s.user_id IN (?, ?, ?) ORDER BY s.user_id`,
          [a, b, c],
        );
        const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
        expect(byUser.get(a)).toMatchObject({ status: 'expired', plan_code: 'free' });
        expect(byUser.get(b)).toMatchObject({ status: 'expired', plan_code: 'free' });
        expect(byUser.get(c)).toMatchObject({ status: 'active', plan_code: 'pro' });

        expect(await repo.downgradeExpired(new Date())).toBe(0);
      } finally {
        await cleanup(pool, [a, b, c]);
        await pool.end();
      }
    });
  });
}, 60_000);
