import type { MysqlDb } from './db.js';
import type { IWebhookEventRepo } from '../interfaces.js';

/**
 * webhook 事件去重仓储。
 *
 * 表的唯一键 `(provider, event_key)` 是最终的并发防线：并发双处理时
 * 第二个 INSERT 会撞唯一键 —— 那不是错误，正是我们要的结果，
 * 所以 ER_DUP_ENTRY 被吃掉并返回 false。
 */
export class MysqlWebhookEventRepo implements IWebhookEventRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async record(provider: string, eventKey: string, detail?: Record<string, unknown>): Promise<boolean> {
    try {
      await this.db().query(
        'INSERT INTO webhook_events (provider, event_key, detail) VALUES (?, ?, ?)',
        [provider, eventKey, detail ? JSON.stringify(detail) : null],
      );
      return true;
    } catch (err: any) {
      // 撞唯一键说明并发下已有人记过 —— 这正是唯一键存在的目的，不是错误
      if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) return false;
      throw err;
    }
  }

  async forget(provider: string, eventKey: string): Promise<void> {
    await this.db().query(
      'DELETE FROM webhook_events WHERE provider = ? AND event_key = ?',
      [provider, eventKey],
    );
  }
}
