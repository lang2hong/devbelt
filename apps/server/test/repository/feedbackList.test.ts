import { describe, expect, it } from 'vitest';
import { MysqlFeedbackRepo } from '../../src/modules/feedback/repository/feedbackRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

type Row = Record<string, unknown>;

/** 按 SQL 片段返回预置结果集；未命中的查询返回空集。 */
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

describe('MysqlFeedbackRepo.list（用户邮箱）', () => {
  it('LEFT JOIN users 并映射 userEmail（含匿名 null）', async () => {
    const { db, queries } = makeDb([
      [/LEFT JOIN users u ON u\.id = f\.user_id/, [
        { id: 2, user_id: 7, user_email: 'owner@example.test', has_reply_key: 1, category: 'bug', content: 'x', status: 'new', create_time: new Date(), update_time: new Date() },
        { id: 1, user_id: null, user_email: null, has_reply_key: 0, category: 'other', content: 'y', status: 'triaged', create_time: new Date(), update_time: new Date() },
      ]],
      [/SELECT COUNT\(\*\) AS n FROM user_feedback/, [{ n: 2 }]],
    ]);

    const page = await new MysqlFeedbackRepo(db).list({ limit: 20 });
    expect(page.items.map((i) => i.userEmail)).toEqual(['owner@example.test', null]);
    const listSql = queries.find((q) => q.includes('LEFT JOIN users u ON u.id = f.user_id'));
    expect(listSql).toContain('u.email AS user_email');
    // 计数查询不引入 join（过滤列都在 f 上）。
    const countSql = queries.find((q) => q.startsWith('SELECT COUNT(*) AS n'));
    expect(countSql).not.toContain('LEFT JOIN');
  });
});
