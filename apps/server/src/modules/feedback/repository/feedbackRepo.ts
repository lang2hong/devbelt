import type { MysqlDb, Queryable } from '../../../repository/mysql/db.js';
import type {
  FeedbackDetail,
  FeedbackEmailStatus,
  FeedbackFilter,
  FeedbackForReply,
  FeedbackOverview,
  FeedbackPage,
  FeedbackReply,
  FeedbackRow,
  FeedbackStatus,
  FeedbackThreadItem,
  FeedbackThreadQuery,
  IFeedbackRepo,
  NewFeedback,
} from '../../../repository/interfaces/feedback.js';

type Exec = Pick<Queryable, 'query'>;
type Rec = Record<string, unknown>;

/** 列表/详情共用列；reply_key_hash 只投影为布尔，不出仓储。 */
const ROW_COLUMNS = `f.id, f.user_id, f.install_id, (f.reply_key_hash IS NOT NULL) AS has_reply_key,
  f.category, f.content, f.contact, f.app_version, f.os,
  f.status, f.admin_note, f.source_ip, f.create_time, f.update_time`;

function toRow(r: Rec): FeedbackRow {
  return {
    id: Number(r.id),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    installId: (r.install_id as string | null) ?? null,
    hasReplyKey: Number(r.has_reply_key ?? 0) === 1,
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

function toReply(r: Rec): FeedbackReply {
  return {
    id: Number(r.id),
    feedbackId: Number(r.feedback_id),
    adminUserId: r.admin_user_id === null || r.admin_user_id === undefined ? null : Number(r.admin_user_id),
    body: String(r.body ?? ''),
    emailStatus: r.email_status as FeedbackEmailStatus,
    emailTo: (r.email_to as string | null) ?? null,
    emailError: (r.email_error as string | null) ?? null,
    createTime: r.create_time as Date,
  };
}

/** mysql2 `query` 返回 `[rows, fields]`；结果集取首段，写语句取 ResultSetHeader。 */
function rowsOf(result: unknown): Rec[] {
  const r = result as [unknown, unknown];
  return Array.isArray(r) && Array.isArray(r[0]) ? (r[0] as Rec[]) : [];
}

function headerOf(result: unknown): { insertId?: number; affectedRows?: number } {
  const r = result as [unknown, unknown];
  const first = Array.isArray(r) ? r[0] : r;
  return (Array.isArray(first) ? first[0] : first) as { insertId?: number; affectedRows?: number };
}

/** 用户反馈仓储（015/017）。列表用 id 倒序 keyset 分页，避免深分页。 */
export class MysqlFeedbackRepo implements IFeedbackRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async create(input: NewFeedback): Promise<number> {
    const res = await this.db().query(
      `INSERT INTO user_feedback
         (user_id, install_id, reply_key_hash, category, content, contact, app_version, os, source_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.userId,
        input.installId,
        input.replyKeyHash,
        input.category,
        input.content,
        input.contact,
        input.appVersion,
        input.os,
        input.sourceIp,
      ],
    );
    return Number(headerOf(res)?.insertId ?? 0);
  }

  async list(filter: FeedbackFilter): Promise<FeedbackPage> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { where.push('f.status = ?'); params.push(filter.status); }
    if (filter.category) { where.push('f.category = ?'); params.push(filter.category); }
    if (filter.userId !== undefined) { where.push('f.user_id = ?'); params.push(filter.userId); }
    if (filter.afterId !== undefined) { where.push('f.id < ?'); params.push(filter.afterId); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter.limit, 1), 100);

    const res = await this.db().query(
      `SELECT ${ROW_COLUMNS}
         FROM user_feedback f
         ${whereSql}
        ORDER BY f.id DESC
        LIMIT ?`,
      [...params, limit],
    );
    const items = rowsOf(res).map(toRow);
    const nextId = items.length === limit ? items[items.length - 1]!.id : null;

    let total: number | undefined;
    if (filter.afterId === undefined) {
      const countRes = await this.db().query(`SELECT COUNT(*) AS n FROM user_feedback f ${whereSql}`, params);
      total = Number(rowsOf(countRes)[0]?.n ?? 0);
    }
    return { items, nextId, ...(total !== undefined ? { total } : {}) };
  }

  async updateStatusInTx(tx: Exec, id: number, status: FeedbackStatus, adminNote: string | null): Promise<boolean> {
    const res = await tx.query(`UPDATE user_feedback SET status = ?, admin_note = ? WHERE id = ?`, [status, adminNote, id]);
    return Number(headerOf(res)?.affectedRows ?? 0) > 0;
  }

  async findDetail(id: number): Promise<FeedbackDetail | undefined> {
    const res = await this.db().query(
      `SELECT ${ROW_COLUMNS}, u.email AS user_email
         FROM user_feedback f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.id = ?`,
      [id],
    );
    const row = rowsOf(res)[0];
    if (!row) return undefined;
    const repliesRes = await this.db().query(
      `SELECT id, feedback_id, admin_user_id, body, email_status, email_to, email_error, create_time
         FROM feedback_replies
        WHERE feedback_id = ?
        ORDER BY id ASC`,
      [id],
    );
    return {
      feedback: toRow(row),
      userEmail: (row.user_email as string | null) ?? null,
      replies: rowsOf(repliesRes).map(toReply),
    };
  }

  async listThread(query: FeedbackThreadQuery): Promise<FeedbackThreadItem[]> {
    const ors: string[] = [];
    const params: unknown[] = [];
    if (query.anonymous) {
      // 账号关联的行只在以该账号登录时可见，故匿名凭证只匹配未关联账号的行。
      ors.push('(f.install_id = ? AND f.reply_key_hash = ? AND f.user_id IS NULL)');
      params.push(query.anonymous.installId, query.anonymous.replyKeyHash);
    }
    if (query.userId !== undefined) {
      ors.push('f.user_id = ?');
      params.push(query.userId);
    }
    if (ors.length === 0) return [];
    const limit = Math.min(Math.max(query.limit, 1), 100);

    const res = await this.db().query(
      `SELECT f.id, f.category, f.content, f.status, f.create_time
         FROM user_feedback f
        WHERE ${ors.join(' OR ')}
        ORDER BY f.id DESC
        LIMIT ?`,
      [...params, limit],
    );
    const items = rowsOf(res).map((r): FeedbackThreadItem => ({
      id: Number(r.id),
      category: r.category as FeedbackThreadItem['category'],
      content: String(r.content ?? ''),
      status: r.status as FeedbackStatus,
      createTime: r.create_time as Date,
      replies: [],
    }));
    if (items.length === 0) return items;

    const ids = items.map((i) => i.id);
    const repliesRes = await this.db().query(
      `SELECT id, feedback_id, body, create_time
         FROM feedback_replies
        WHERE feedback_id IN (${ids.map(() => '?').join(',')})
        ORDER BY id ASC`,
      ids,
    );
    const byFeedback = new Map(items.map((i) => [i.id, i]));
    for (const r of rowsOf(repliesRes)) {
      byFeedback.get(Number(r.feedback_id))?.replies.push({
        id: Number(r.id),
        body: String(r.body ?? ''),
        createTime: r.create_time as Date,
      });
    }
    return items;
  }

  async findForReplyInTx(tx: Exec, id: number): Promise<FeedbackForReply | undefined> {
    const res = await tx.query(
      `SELECT f.id, f.status, f.content, f.contact, u.email AS user_email
         FROM user_feedback f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.id = ?
        FOR UPDATE OF f`,
      [id],
    );
    const r = rowsOf(res)[0];
    if (!r) return undefined;
    return {
      id: Number(r.id),
      status: r.status as FeedbackStatus,
      content: String(r.content ?? ''),
      contact: (r.contact as string | null) ?? null,
      userEmail: (r.user_email as string | null) ?? null,
    };
  }

  async createReplyInTx(
    tx: Exec,
    input: { feedbackId: number; adminUserId: number; body: string; emailStatus: FeedbackEmailStatus; emailTo: string | null },
  ): Promise<number> {
    const res = await tx.query(
      `INSERT INTO feedback_replies (feedback_id, admin_user_id, body, email_status, email_to)
       VALUES (?, ?, ?, ?, ?)`,
      [input.feedbackId, input.adminUserId, input.body, input.emailStatus, input.emailTo],
    );
    return Number(headerOf(res)?.insertId ?? 0);
  }

  async markTriagedIfNewInTx(tx: Exec, id: number): Promise<void> {
    await tx.query(`UPDATE user_feedback SET status = 'triaged' WHERE id = ? AND status = 'new'`, [id]);
  }

  async updateReplyEmail(replyId: number, status: 'sent' | 'failed', error: string | null): Promise<void> {
    await this.db().query(
      `UPDATE feedback_replies SET email_status = ?, email_error = ? WHERE id = ? AND email_status = 'pending'`,
      [status, error === null ? null : error.slice(0, 200), replyId],
    );
  }

  async overview(): Promise<FeedbackOverview> {
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
    const [syncedRow] = await rows(`SELECT COUNT(*) AS users FROM personal_sync_state`);
    const [topupRow] = await rows(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS cents
         FROM orders WHERE purpose = 'topup' AND status = 'paid' AND paid_time >= NOW() - INTERVAL 30 DAY`,
    );
    const statusRows = await rows(`SELECT status, COUNT(*) AS n FROM user_feedback GROUP BY status`);
    const categoryRows = await rows(`SELECT category, COUNT(*) AS n FROM user_feedback GROUP BY category ORDER BY n DESC`);
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
    const synced = syncedRow ?? {};
    const topup = topupRow ?? {};
    const byStatus = statusRows.map((r) => ({ status: String(r.status ?? ''), count: num(r.n) }));
    const byCategory = categoryRows.map((r) => ({ category: String(r.category ?? ''), count: num(r.n) }));
    return {
      users: { total: num(users.total), new7d: num(users.new7d), active7d: num(users.active7d) },
      devices: {
        active: num(devices.active),
        platforms: platformRows.map((r) => ({ platform: String(r.platform ?? ''), count: num(r.n) })),
        versions: versionRows.map((r) => ({ version: String(r.version ?? ''), count: num(r.n) })),
      },
      sync: { connectionMetas: num(sync.metas), storageBytes: num(sync.bytes), syncedUsers: num(synced.users) },
      ai: { monthTokens: num(ai.tokens), monthRequests: num(ai.requests) },
      billing: {
        paidOrders30d: num(billing.orders),
        revenueCents30d: num(billing.cents),
        topupOrders30d: num(topup.orders),
        topupRevenueCents30d: num(topup.cents),
      },
      feedback: {
        newCount: byStatus.find((x) => x.status === 'new')?.count ?? 0,
        byStatus,
        byCategory,
      },
    };
  }
}
