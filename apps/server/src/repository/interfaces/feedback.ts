/** 用户反馈（015）：允许匿名；status 由运营流转。 */

export type FeedbackCategory = 'bug' | 'feature' | 'other';
export type FeedbackStatus = 'new' | 'triaged' | 'done' | 'rejected';

export interface FeedbackRow {
  id: number;
  userId: number | null;
  installId: string | null;
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

export interface AdminOverview {
  users: { total: number; new7d: number; active7d: number };
  devices: {
    active: number;
    platforms: Array<{ platform: string; count: number }>;
    versions: Array<{ version: string; count: number }>;
  };
  sync: { connectionMetas: number; storageBytes: number };
  ai: { monthTokens: number; monthRequests: number };
  billing: { paidOrders30d: number; revenueCents30d: number };
  feedback: { newCount: number; byStatus: Array<{ status: string; count: number }> };
}

export interface IFeedbackRepo {
  create(input: NewFeedback): Promise<number>;
  list(filter: FeedbackFilter): Promise<FeedbackPage>;
  updateStatusInTx(
    tx: { query(sql: string, params?: unknown[]): Promise<unknown> },
    id: number,
    status: FeedbackStatus,
    adminNote: string | null,
  ): Promise<boolean>;
  overview(): Promise<AdminOverview>;
}