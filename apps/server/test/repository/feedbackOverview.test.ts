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

describe('MysqlFeedbackRepo.overview（同步用户 / AI 充值 / 反馈分类）', () => {
  it('映射三项新增指标', async () => {
    const { db, queries } = makeDb([
      [/FROM personal_sync_state/, [{ users: '12' }]],
      [/purpose = 'topup'/, [{ orders: 3, cents: '5800' }]],
      [/GROUP BY category/, [{ category: 'bug', n: 7 }, { category: 'feature', n: '2' }]],
      [/GROUP BY status/, [{ status: 'new', n: 4 }, { status: 'done', n: 5 }]],
    ]);
    const o = await new MysqlFeedbackRepo(db).overview();

    expect(o.sync.syncedUsers).toBe(12);
    expect(o.billing.topupOrders30d).toBe(3);
    expect(o.billing.topupRevenueCents30d).toBe(5800);
    expect(o.feedback.byCategory).toEqual([
      { category: 'bug', count: 7 },
      { category: 'feature', count: 2 },
    ]);
    // 既有指标不受影响。
    expect(o.feedback.newCount).toBe(4);
    expect(o.feedback.byStatus).toEqual([{ status: 'new', count: 4 }, { status: 'done', count: 5 }]);
    // 总营收查询保持不按 purpose 过滤（充值是其子集，不能重复计入）。
    const total = queries.find((q) => /FROM orders WHERE status = 'paid'/.test(q));
    expect(total).toBeDefined();
    expect(total).not.toMatch(/purpose/);
  });

  it('空表时全部为 0 / 空数组', async () => {
    const { db } = makeDb([]);
    const o = await new MysqlFeedbackRepo(db).overview();
    expect(o.sync.syncedUsers).toBe(0);
    expect(o.billing).toEqual({
      paidOrders30d: 0,
      revenueCents30d: 0,
      topupOrders30d: 0,
      topupRevenueCents30d: 0,
    });
    expect(o.feedback).toEqual({ newCount: 0, byStatus: [], byCategory: [] });
  });
});
