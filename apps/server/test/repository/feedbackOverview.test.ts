import { describe, expect, it } from 'vitest';
import { MysqlFeedbackRepo } from '../../src/modules/feedback/repository/feedbackRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

type Row = Record<string, unknown>;

/** 按 SQL 片段返回预置结果集；未命中的查询返回空集（模拟空表）。 */
function makeDb(responses: Array<[RegExp, Row[]]>): { db: () => MysqlDb; queries: string[] } {
  const queries: string[] = [];
  const db = {
    database: 'test',
    query: async (sql: string) => {
      queries.push(sql);
      const hit = responses.find(([re]) => re.test(sql));
      return [hit ? hit[1] : [], undefined];
    },
    getConnection: async () => { throw new Error('unused'); },
  } as unknown as MysqlDb;
  return { db: () => db, queries };
}

const today = new Date().toISOString().slice(0, 10);
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

describe('MysqlFeedbackRepo.overview', () => {
  it('映射趋势序列、营收口径与 AI 原始/计费 token', async () => {
    const { db, queries } = makeDb([
      [/COUNT\(\*\) AS total/, [{ total: 20, new7d: 7, active7d: 11 }]],
      [/DATE\(create_time\) AS day[\s\S]*FROM users/, [{ day: today, n: '5' }, { day: twoDaysAgo, n: '2' }]],
      [/COUNT\(\*\) AS active FROM devices/, [{ active: 6 }]],
      [/FROM personal_connection_meta/, [{ metas: 3, bytes: '2048' }]],
      [/FROM ai_token_usage/, [{ raw_tokens: '5000', billed_tokens: '7000', requests: '12' }]],
      [/FROM ai_request_log/, [{ day: today, tokens: '1200', requests: '3' }]],
      [/DATE\(paid_time\) AS day/, [
        { day: today, purpose: 'plan', cents: '9900' },
        { day: today, purpose: 'topup', cents: '900' },
      ]],
      [/FROM personal_sync_state/, [{ users: '12' }]],
      [/purpose = 'topup'/, [{ orders: 1, cents: '900' }]],
      [/FROM orders[\s\S]*paid_time >= NOW\(\)/, [{ orders: 4, cents: '10800' }]],
      [/GROUP BY status/, [{ status: 'new', n: 4 }, { status: 'done', n: 5 }]],
      [/GROUP BY category/, [{ category: 'bug', n: 7 }, { category: 'feature', n: '2' }]],
      [/GROUP BY device_platform/, [{ platform: 'linux', n: 4 }]],
      [/GROUP BY client_version/, [{ version: '0.4.1', n: 3 }]],
    ]);
    const o = await new MysqlFeedbackRepo(db).overview();

    // 30 天序列：今天/两天前有值，其余补 0。
    expect(o.users.daily).toHaveLength(30);
    expect(o.users.daily[29]).toEqual({ day: today, newUsers: 5 });
    expect(o.users.daily[27]).toEqual({ day: twoDaysAgo, newUsers: 2 });
    expect(o.users.daily[28]).toEqual({ day: o.users.daily[28]!.day, newUsers: 0 });

    expect(o.ai.monthTokens).toBe(5000);
    expect(o.ai.monthBilledTokens).toBe(7000);
    expect(o.ai.monthRequests).toBe(12);
    expect(o.ai.daily[29]).toEqual({ day: today, tokens: 1200, requests: 3 });
    expect(o.ai.daily[0]!.tokens).toBe(0);

    expect(o.billing.paidOrders30d).toBe(4);
    expect(o.billing.revenueCents30d).toBe(10800);
    expect(o.billing.topupOrders30d).toBe(1);
    expect(o.billing.topupRevenueCents30d).toBe(900);
    expect(o.billing.daily[29]).toEqual({ day: today, planCents: 9900, topupCents: 900 });
    expect(o.billing.daily[0]!.planCents).toBe(0);

    expect(o.sync).toEqual({ connectionMetas: 3, storageBytes: 2048, syncedUsers: 12 });
    expect(o.feedback.newCount).toBe(4);
    expect(o.feedback.byCategory).toEqual([{ category: 'bug', count: 7 }, { category: 'feature', count: 2 }]);
    expect(o.devices).toEqual({
      active: 6,
      platforms: [{ platform: 'linux', count: 4 }],
      versions: [{ version: '0.4.1', count: 3 }],
    });

    // 营收口径：paid/fulfilled + 排除 manual；总量查询不按 purpose 过滤。
    const total = queries.find((q) => /FROM orders[\s\S]*paid_time >= NOW\(\)/.test(q));
    expect(total).toContain("status IN ('paid', 'fulfilled')");
    expect(total).toContain("channel <> 'manual'");
    expect(total).not.toMatch(/purpose/);

    // AI 日序列按 create_time 聚合原始 token。
    const aiDaily = queries.find((q) => q.includes('FROM ai_request_log'));
    expect(aiDaily).toContain('raw_prompt_tokens + raw_completion_tokens');
  });

  it('空表时 30 天序列全部为 0', async () => {
    const { db } = makeDb([]);
    const o = await new MysqlFeedbackRepo(db).overview();
    expect(o.users.total).toBe(0);
    expect(o.users.daily).toHaveLength(30);
    expect(o.ai.daily).toHaveLength(30);
    expect(o.billing.daily).toHaveLength(30);
    expect(o.users.daily.every((p) => p.newUsers === 0)).toBe(true);
    expect(o.ai.daily.every((p) => p.tokens === 0 && p.requests === 0)).toBe(true);
    expect(o.billing.daily.every((p) => p.planCents === 0 && p.topupCents === 0)).toBe(true);
    expect(o.billing).toMatchObject({
      paidOrders30d: 0,
      revenueCents30d: 0,
      topupOrders30d: 0,
      topupRevenueCents30d: 0,
    });
    expect(o.ai.monthTokens).toBe(0);
    expect(o.ai.monthBilledTokens).toBe(0);
    expect(o.feedback).toEqual({ newCount: 0, byStatus: [], byCategory: [] });
  });
});