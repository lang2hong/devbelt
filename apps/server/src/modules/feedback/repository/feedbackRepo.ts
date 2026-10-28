import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';
import type {
  AdminOverview,
  FeedbackFilter,
  FeedbackPage,
  FeedbackRow,
  FeedbackStatus,
  IFeedbackRepo,
  NewFeedback,
} from '../../../repository/interfaces/feedback.js';

function toRow(r: Record<string, unknown>): FeedbackRow {
  return {
    id: Number(r.id),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    installId: (r.install_id as string | null) ?? null,
    category: r.category as FeedbackRow['category'],
    content: String(r.content ?? ''),
    contact: (r.contact as string | null) ?? null,
    appVersion: (r.app_version as string | null) ?? null,
    os: (r.os as string | null) ?? null,
    status: r.status as FeedbackStatus,
    adminNote: (r.admin_note as string | null) ?? null,
    sourceIp: (r.source_ip as string | null) ?? null,
    createTime: r.create_time as Date,
    updateTime: r.update_time as Date,
  };
}

/** 用户反馈仓储（015）。列表用 id 倒序 keyset 分页，避免深分页。 */
export class MysqlFeedbackRepo implements IFeedbackRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(input: NewFeedback): Promise<number> {
    const [res] = (await this.db().query(
      `INSERT INTO user_feedback
         (user_id, install_id, category, content, contact, app_version, os, source_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.userId,
        input.installId,
        input.category,
        input.content,
        input.contact,
        input.appVersion,
        input.os,
        input.sourceIp,
      ],
    )) as unknown as [Array<{ insertId?: number }>, unknown];
    const first = Array.isArray(res) ? res[0] : (res as { insertId?: number });
    return Number((first as { insertId?: number } | undefined)?.insertId ?? 0);
  }

  async list(filter: FeedbackFilter): Promise<FeedbackPage> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.category) { where.push('category = ?'); params.push(filter.category); }
    if (filter.userId !== undefined) { where.push('user_id = ?'); params.push(filter.userId); }
    if (filter.afterId !== undefined) { where.push('id < ?'); params.push(filter.afterId); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit, 1), 100);

    const rows = (await this.db().query(
      `SELECT id, user_id, install_id, category, content, contact, app_version, os,
              status, admin_note, source_ip, create_time, update_time
         FROM user_feedback
         ${whereSql}
        ORDER BY id DESC
        LIMIT ?`,
      [...params, limit],
    )) as unknown as [Array<Record<string, unknown>>, unknown];
    const list = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>;
    const items = list.map(toRow);
    const nextId = items.length === limit ? items[items.length - 1]!.id : null;

    let total: number | undefined;
    if (filter.afterId === undefined) {
      const countRows = (await this.db().query(
        `SELECT COUNT(*) AS n FROM user_feedback ${whereSql}`,
        params,
      )) as unknown as [Array<{ n: number | string }>, unknown];
      total = Number((Array.isArray(countRows) ? countRows[0]?.[0] : undefined)?.n ?? 0);
    }
    return { items, nextId, ...(total !== undefined ? { total } : {}) };
  }

  async updateStatusInTx(
    tx: Pick<Queryable, 'query'>,
    id: number,
    status: FeedbackStatus,
    adminNote: string | null,
  ): Promise<boolean> {
    const [res] = (await tx.query(
      `UPDATE user_feedback SET status = ?, admin_note = ? WHERE id = ?`,
      [status, adminNote, id],
    )) as unknown as [Array<{ affectedRows?: number }>, unknown];
    const first = Array.isArray(res) ? res[0] : (res as { affectedRows?: number });
    return Number((first as { affectedRows?: number } | undefined)?.affectedRows ?? 0) > 0;
  }

  async overview(): Promise<AdminOverview> {
    const db = this.db();
    const num = (v: unknown): number => Number(v ?? 0);
    const rows = async (sql: string): Promise<Array<Record<string, unknown>>> => {
      const r = (await db.query(sql)) as unknown as [Array<Record<string, unknown>>, unknown];
      return Array.isArray(r) ? (r[0] ?? []) : [];
    };

    const [usersRow] = await rows(
      `SELECT COUNT(*) AS total,
              SUM(create_time >= NOW() - INTERVAL 7 DAY) AS new7d,
              SUM(last_login_time >= NOW() - INTERVAL 7 DAY) AS active7d
         FROM users`,
    );
    const [devicesRow] = await rows(
      `SELECT COUNT(*) AS active FROM devices WHERE status = 'active'`,
    );
    const [syncRow] = await rows(
      `SELECT COUNT(*) AS metas, COALESCE(SUM(OCTET_LENGTH(ciphertext)), 0) AS bytes
         FROM personal_connection_meta WHERE delete_time IS NULL`,
    );
    const [aiRow] = await rows(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
              COALESCE(SUM(request_count), 0) AS requests
         FROM ai_token_usage WHERE usage_month = DATE_FORMAT(NOW(), '%Y-%m')`,
    );
    const [billingRow] = await rows(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS cents
         FROM orders WHERE status = 'paid' AND paid_time >= NOW() - INTERVAL 30 DAY`,
    );
    const statusRows = await rows(`SELECT status, COUNT(*) AS n FROM user_feedback GROUP BY status`);
    const platformRows = await rows(
      `SELECT device_platform AS platform, COUNT(*) AS n
         FROM devices WHERE status = 'active'
        GROUP BY device_platform ORDER BY n DESC LIMIT 8`,
    );
    const versionRows = await rows(
      `SELECT client_version AS version, COUNT(*) AS n
         FROM devices WHERE status = 'active'
        GROUP BY client_version ORDER BY n DESC LIMIT 8`,
    );

    const users = usersRow ?? {};
    const devices = devicesRow ?? {};
    const sync = syncRow ?? {};
    const ai = aiRow ?? {};
    const billing = billingRow ?? {};
    const byStatus = statusRows.map((r) => ({ status: String(r.status ?? ''), count: num(r.n) }));
    return {
      users: { total: num(users.total), new7d: num(users.new7d), active7d: num(users.active7d) },
      devices: {
        active: num(devices.active),
        platforms: platformRows.map((r) => ({ platform: String(r.platform ?? ''), count: num(r.n) })),
        versions: versionRows.map((r) => ({ version: String(r.version ?? ''), count: num(r.n) })),
      },
      sync: { connectionMetas: num(sync.metas), storageBytes: num(sync.bytes) },
      ai: { monthTokens: num(ai.tokens), monthRequests: num(ai.requests) },
      billing: { paidOrders30d: num(billing.orders), revenueCents30d: num(billing.cents) },
      feedback: {
        newCount: byStatus.find((x) => x.status === 'new')?.count ?? 0,
        byStatus,
      },
    };
  }
}