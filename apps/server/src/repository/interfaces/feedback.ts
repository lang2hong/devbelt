/** 用户反馈（015）：允许匿名；status 由运营流转。站内回复见 017。 */

import type { TelemetryOverview } from './telemetry.js';

export type FeedbackCategory = 'bug' | 'feature' | 'other';
export type FeedbackStatus = 'new' | 'triaged' | 'done' | 'rejected';
export type FeedbackEmailStatus = 'skipped' | 'pending' | 'sent' | 'failed';
export type FeedbackEmailTarget = 'none' | 'account' | 'contact';

export interface FeedbackRow {
  id: number;
  userId: number | null;
  /** 关联账号邮箱（LEFT JOIN users；匿名反馈为 null）。 */
  userEmail: string | null;
  installId: string | null;
  /** 是否带 replyKey 哈希（可站内送达给匿名安装）；哈希本身不出仓储。 */
  hasReplyKey: boolean;
  category: FeedbackCategory;
  content: string;
  contact: string | null;
  appVersion: string | null;
  os: string | null;
  status: FeedbackStatus;
  adminNote: string | null;
  sourceIp: string | null;
  createTime: Date;
  updateTime: Date;
}

export interface NewFeedback {
  userId: number | null;
  installId: string | null;
  /** replyKey 的 SHA-256（hex）；无 replyKey 时为 null。 */
  replyKeyHash: string | null;
  category: FeedbackCategory;
  content: string;
  contact: string | null;
  appVersion: string | null;
  os: string | null;
  sourceIp: string | null;
}

export interface FeedbackFilter {
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  userId?: number;
  /** keyset 游标：只返回 id < afterId 的行。 */
  afterId?: number;
  limit: number;
}

export interface FeedbackPage {
  items: FeedbackRow[];
  nextId: number | null;
  total?: number;
}

/** 管理员回复（017）。 */
export interface FeedbackReply {
  id: number;
  feedbackId: number;
  adminUserId: number | null;
  body: string;
  emailStatus: FeedbackEmailStatus;
  emailTo: string | null;
  emailError: string | null;
  createTime: Date;
}

/** 反馈附件（021）：图片元数据，文件本体在服务端磁盘。 */
export type FeedbackAttachmentMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface FeedbackAttachment {
  id: number;
  feedbackId: number;
  fileName: string;
  mime: FeedbackAttachmentMime;
  sizeBytes: number;
  createTime: Date;
}

/** 仓储读取附件时额外带出磁盘文件名（不下发给客户端）。 */
export interface FeedbackAttachmentFile extends FeedbackAttachment {
  storageName: string;
}

export interface NewFeedbackAttachment {
  storageName: string;
  fileName: string;
  mime: FeedbackAttachmentMime;
  sizeBytes: number;
}

/** 后台详情：反馈 + 关联账号邮箱 + 回复历史 + 附件。 */
export interface FeedbackDetail {
  feedback: FeedbackRow;
  userEmail: string | null;
  replies: FeedbackReply[];
  attachments: FeedbackAttachment[];
}

/** 回复前在事务内锁定读取的最小字段。 */
export interface FeedbackForReply {
  id: number;
  status: FeedbackStatus;
  content: string;
  contact: string | null;
  userEmail: string | null;
}

/** 扩展可见的线程条目：不含后台备注、IP、管理员身份、邮件投递信息。 */
export interface FeedbackThreadItem {
  id: number;
  category: FeedbackCategory;
  content: string;
  status: FeedbackStatus;
  createTime: Date;
  replies: Array<{ id: number; body: string; createTime: Date }>;
}

/**
 * 线程查询条件（并集）：
 * - `anonymous`：install_id + reply_key_hash 匹配，且行**未关联账号**；
 * - `userId`：当前登录账号的全部反馈（跨安装）。
 * 账号关联的反馈只在以该账号登录时可见（与扩展的账号数据隔离一致）。
 */
export interface FeedbackThreadQuery {
  anonymous?: { installId: string; replyKeyHash: string };
  userId?: number;
  limit: number;
}

export interface FeedbackOverview {
  users: {
    total: number;
    new7d: number;
    active7d: number;
    /** 近 30 天每日新增用户（UTC，服务端补 0）。 */
    daily: Array<{ day: string; newUsers: number }>;
  };
  devices: {
    active: number;
    platforms: Array<{ platform: string; count: number }>;
    versions: Array<{ version: string; count: number }>;
  };
  /** syncedUsers：已启用个人同步的用户数（personal_sync_state 每用户一行）。 */
  sync: { connectionMetas: number; storageBytes: number; syncedUsers: number };
  ai: {
    /** 原始 token（上游真实用量）。 */
    monthTokens: number;
    /** 计费 token（含倍率），用于展示口径差异。 */
    monthBilledTokens: number;
    monthRequests: number;
    /** 近 30 天每日原始 token 与请求数（UTC，服务端补 0）。 */
    daily: Array<{ day: string; tokens: number; requests: number }>;
  };
  /** topup* 是 paidOrders30d / revenueCents30d 中 AI 充值订单的子集，不是额外增量。 */
  billing: {
    paidOrders30d: number;
    revenueCents30d: number;
    topupOrders30d: number;
    topupRevenueCents30d: number;
    /** 近 30 天手工赠送（channel='manual' 且 fulfilled）；面值不是营收。 */
    manualGift: { orders: number; faceValueCents: number; tokens: number };
    /** 近 30 天每日营收，按套餐/充值拆分（UTC，服务端补 0）。 */
    daily: Array<{ day: string; planCents: number; topupCents: number }>;
  };
  feedback: {
    newCount: number;
    byStatus: Array<{ status: string; count: number }>;
    byCategory: Array<{ category: string; count: number }>;
  };
}

export interface AdminOverview extends FeedbackOverview {
  /** 扩展匿名心跳（016）：安装/活跃，不关联账号。 */
  telemetry: TelemetryOverview;
}

type Exec = { query(sql: string, params?: unknown[]): Promise<unknown> };

export interface IFeedbackRepo {
  create(input: NewFeedback): Promise<number>;
  /** 附件元数据批量写入（文件已落盘；失败由调用方补偿删除）。 */
  createAttachments(feedbackId: number, items: readonly NewFeedbackAttachment[]): Promise<void>;
  /** 按反馈 + 附件 id 读取，避免跨反馈越权。 */
  findAttachment(feedbackId: number, attachmentId: number): Promise<FeedbackAttachmentFile | undefined>;
  /** 附件写入失败时的补偿：删除反馈行（级联删除附件行）。 */
  deleteFeedback(id: number): Promise<void>;
  list(filter: FeedbackFilter): Promise<FeedbackPage>;
  updateStatusInTx(tx: Exec, id: number, status: FeedbackStatus, adminNote: string | null): Promise<boolean>;
  overview(): Promise<FeedbackOverview>;
  findDetail(id: number): Promise<FeedbackDetail | undefined>;
  listThread(query: FeedbackThreadQuery): Promise<FeedbackThreadItem[]>;
  /** 事务内 `FOR UPDATE` 锁定反馈行（串行化并发回复与状态流转）。 */
  findForReplyInTx(tx: Exec, id: number): Promise<FeedbackForReply | undefined>;
  createReplyInTx(
    tx: Exec,
    input: { feedbackId: number; adminUserId: number; body: string; emailStatus: FeedbackEmailStatus; emailTo: string | null },
  ): Promise<number>;
  /** 回复后 `new` → `triaged`；其余状态不变。 */
  markTriagedIfNewInTx(tx: Exec, id: number): Promise<void>;
  /** 事务提交后记录邮件投递结果。 */
  updateReplyEmail(replyId: number, status: 'sent' | 'failed', error: string | null): Promise<void>;
}
