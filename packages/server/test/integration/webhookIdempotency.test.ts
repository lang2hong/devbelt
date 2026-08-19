import { describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { initSchema } from '../../src/repository/mysql/schema.js';
import { MysqlWebhookEventRepo } from '../../src/repository/mysql/webhookEventRepo.js';
import { MysqlSubscriptionRepo } from '../../src/repository/mysql/subscriptionRepo.js';
import { EXPIRABLE_STATUSES } from '../../src/domain/enums.js';
import { resolveTestDb, parseMysqlUrl } from './testDb.js';

/**
 * 真库验证 webhook 幂等表与到期状态集合。
 *
 * 桩测试守得住分支逻辑，守不住唯一键在**并发**下是否真的挡住第二次插入，
 * 也守不住 `status IN (?, ?, ?)` 的参数展开是否正确。
 */
const URL = process.env.MYSQL_TEST_URL;
// 门禁只在真要连库时求值：URL 未设置时整体 skip，不能因环境变量让文件失败
const DB_NAME = URL ? resolveTestDb() : 'skipped';

const DAY = 86400_000;

describe.skipIf(!URL)('webhook 幂等与到期状态（isolated test db）', () => {
  async function freshPool() {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    return createPool({ host, port, user, password, database: DB_NAME, waitForConnections: true, connectionLimit: 8 });
  }

  const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it('initSchema 建出 webhook_events 与唯一键', async () => {
    const pool = await freshPool();
    try {
      await initSchema({ mysql: pool, log: console } as any);
      const [idx]: any = await pool.query('SHOW INDEX FROM webhook_events');
      const uq = idx.filter((i: any) => i.Key_name === 'uq_we_provider_key')
        .sort((a: any, b: any) => a.Seq_in_index - b.Seq_in_index)
        .map((i: any) => i.Column_name);
      expect(uq).toEqual(['provider', 'event_key']);
      expect(idx.some((i: any) => i.Key_name === 'idx_we_time')).toBe(true);

      const [tinfo]: any = await pool.query(
        `SELECT table_collation c FROM information_schema.tables
          WHERE table_schema = ? AND table_name = 'webhook_events'`,
        [DB_NAME],
      );
      expect(String(tinfo[0].c)).toMatch(/^utf8mb4/);

      await initSchema({ mysql: pool, log: console } as any); // 幂等
    } finally {
      await pool.end();
    }
  });

  it('record 重复插入返回 false 而不抛错', async () => {
    const pool = await freshPool();
    const repo = new MysqlWebhookEventRepo(() => pool as any);
    const key = `evt-${tag()}`;
    try {
      expect(await repo.seen('stripe', key)).toBe(false);
      expect(await repo.record('stripe', key, { type: 'renewed' })).toBe(true);
      expect(await repo.seen('stripe', key)).toBe(true);
      // 第二次：撞唯一键，被吃掉
      expect(await repo.record('stripe', key)).toBe(false);
    } finally {
      await pool.query('DELETE FROM webhook_events WHERE event_key = ?', [key]);
      await pool.end();
    }
  });

  /**
   * 并发下 seen() 可能两次都返回 false（两个请求同时到），唯一键是最后防线。
   * 8 路并发只应有一个 record 成功。
   */
  it('并发 record 只有一个成功', async () => {
    const pool = await freshPool();
    const repo = new MysqlWebhookEventRepo(() => pool as any);
    const key = `evt-race-${tag()}`;
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repo.record('stripe', key)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const [rows]: any = await pool.query(
        'SELECT COUNT(*) c FROM webhook_events WHERE event_key = ?', [key],
      );
      expect(Number(rows[0].c)).toBe(1);
    } finally {
      await pool.query('DELETE FROM webhook_events WHERE event_key = ?', [key]);
      await pool.end();
    }
  });

  it('同一 event_key 跨 provider 各自独立', async () => {
    const pool = await freshPool();
    const repo = new MysqlWebhookEventRepo(() => pool as any);
    const key = `evt-cross-${tag()}`;
    try {
      expect(await repo.record('stripe', key)).toBe(true);
      // 另一家支付商用同样的编号是完全可能的，不能被吃掉
      expect(await repo.record('lemonsqueezy', key)).toBe(true);
      expect(await repo.seen('stripe', key)).toBe(true);
      expect(await repo.seen('lemonsqueezy', key)).toBe(true);
      expect(await repo.seen('manual', key)).toBe(false);
    } finally {
      await pool.query('DELETE FROM webhook_events WHERE event_key = ?', [key]);
      await pool.end();
    }
  });

  it('detail 是合法 JSON，且长 event_key 不被截断', async () => {
    const pool = await freshPool();
    const repo = new MysqlWebhookEventRepo(() => pool as any);
    // 191 是 utf8mb4 下能进唯一键的上限，Stripe 的 evt_ id 远短于此
    const key = ('k' + tag()).padEnd(191, 'x').slice(0, 191);
    try {
      await repo.record('stripe', key, { nested: { a: [1, 2] }, s: '中文🙂' });
      const [rows]: any = await pool.query(
        'SELECT event_key, detail FROM webhook_events WHERE provider = ? AND event_key = ?',
        ['stripe', key],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].event_key).toBe(key);
      expect(JSON.parse(rows[0].detail)).toEqual({ nested: { a: [1, 2] }, s: '中文🙂' });
    } finally {
      await pool.query('DELETE FROM webhook_events WHERE event_key = ?', [key]);
      await pool.end();
    }
  });

  describe('到期状态集合', () => {
    async function isoUser(pool: any, t: string, plan = 'pro'): Promise<number> {
      const [ins]: any = await pool.query(
        'INSERT INTO users (email, password_hash, plan_code) VALUES (?, ?, ?)',
        [`exp-${t}@dbclient.dev`, 'not-used', plan],
      );
      return ins.insertId as number;
    }

    it('expireOne 处理 active / trialing / canceled，不处理 expired', async () => {
      const pool = await freshPool();
      const repo = new MysqlSubscriptionRepo(() => pool as any);
      const ids: number[] = [];
      try {
        const past = new Date(Date.now() - DAY);
        for (const status of ['active', 'trialing', 'canceled', 'expired']) {
          const uid = await isoUser(pool, `${status}-${tag()}`);
          ids.push(uid);
          await pool.query(
            'INSERT INTO subscriptions (user_id, plan_code, status, period_end_time) VALUES (?, ?, ?, ?)',
            [uid, 'pro', status, past],
          );
          const changed = await repo.expireOne(uid, new Date());
          expect(changed, `${status} 的处理结果不符`).toBe(status !== 'expired');
        }
        // 前三个都变 expired 且用户降到 free
        const [rows]: any = await pool.query(
          `SELECT s.user_id, s.status, u.plan_code FROM subscriptions s
             JOIN users u ON u.id = s.user_id WHERE s.user_id IN (?)`,
          [ids],
        );
        for (const r of rows) expect(r.status).toBe('expired');
        // expired 那个用户的 plan 没被这次调用改动（仍是 pro）
        const last = rows.find((r: any) => r.user_id === ids[3]);
        expect(last.plan_code).toBe('pro');
      } finally {
        for (const id of ids) await pool.query('DELETE FROM users WHERE id = ?', [id]);
        await pool.end();
      }
    });

    it('downgradeExpired 的行数只计可降级状态', async () => {
      const pool = await freshPool();
      const repo = new MysqlSubscriptionRepo(() => pool as any);
      const ids: number[] = [];
      try {
        const past = new Date(Date.now() - DAY);
        const future = new Date(Date.now() + DAY);
        // 三个可降级 + 一个终态 + 一个未到期
        const plan: Array<[string, Date]> = [
          ['active', past], ['trialing', past], ['canceled', past],
          ['expired', past], ['active', future],
        ];
        for (const [status, end] of plan) {
          const uid = await isoUser(pool, `dg-${status}-${tag()}`);
          ids.push(uid);
          await pool.query(
            'INSERT INTO subscriptions (user_id, plan_code, status, period_end_time) VALUES (?, ?, ?, ?)',
            [uid, 'pro', status, end],
          );
        }

        // 库里可能有其他测试留下的行，所以取调用前后的差值而不是绝对值
        const countExpirable = async () => {
          const [r]: any = await pool.query(
            `SELECT COUNT(*) c FROM subscriptions
              WHERE status IN (?) AND period_end_time <= NOW()`,
            [[...EXPIRABLE_STATUSES]],
          );
          return Number(r[0].c);
        };
        const before = await countExpirable();
        const n = await repo.downgradeExpired(new Date());
        expect(n).toBe(before);
        expect(await countExpirable()).toBe(0);

        const [rows]: any = await pool.query(
          'SELECT user_id, status FROM subscriptions WHERE user_id IN (?)', [ids],
        );
        const byUser = new Map(rows.map((r: any) => [r.user_id, r.status]));
        expect(byUser.get(ids[0])).toBe('expired');
        expect(byUser.get(ids[1])).toBe('expired');
        expect(byUser.get(ids[2])).toBe('expired');
        expect(byUser.get(ids[3])).toBe('expired');
        // 未到期的不动
        expect(byUser.get(ids[4])).toBe('active');
      } finally {
        for (const id of ids) await pool.query('DELETE FROM users WHERE id = ?', [id]);
        await pool.end();
      }
    });
  });
}, 60_000);
