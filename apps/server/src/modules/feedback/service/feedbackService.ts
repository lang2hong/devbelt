import { createHash } from 'node:crypto';
import { ValidationError } from '../../../domain/errors.js';
import type {
  FeedbackCategory,
  FeedbackStatus,
  FeedbackThreadItem,
  IFeedbackRepo,
} from '../../../repository/interfaces/feedback.js';

export const MAX_FEEDBACK_CONTENT = 4000;
export const MAX_FEEDBACK_CONTACT = 200;
export const MAX_FEEDBACK_INSTALL_ID = 64;
export const MAX_FEEDBACK_APP_VERSION = 64;
export const MAX_FEEDBACK_OS = 100;
/** 线程单次最多返回的反馈条数。 */
export const MAX_THREAD_ITEMS = 50;

/** 扩展生成的 replyKey：32 字节随机数的 base64url（无填充）= 43 字符。 */
export const REPLY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const CATEGORIES: readonly FeedbackCategory[] = ['bug', 'feature', 'other'];
const STATUSES: readonly FeedbackStatus[] = ['new', 'triaged', 'done', 'rejected'];

export interface SubmitFeedbackInput {
  userId: number | null;
  installId?: string;
  replyKey?: string;
  category: string;
  content: string;
  contact?: string;
  appVersion?: string;
  os?: string;
  sourceIp?: string;
}

export interface ThreadInput {
  installId?: string;
  replyKey?: string;
  /** 已验证的登录账号（可选登录解析结果）。 */
  userId: number | null;
}

/** replyKey 只以 SHA-256 形式落库/比对。 */
export function hashReplyKey(replyKey: string): string {
  return createHash('sha256').update(replyKey, 'utf8').digest('hex');
}

/** 用户反馈：校验、裁剪与落库。路由负责限流与身份解析，本层只做纯校验。 */
export class FeedbackService {
  constructor(private readonly repo: IFeedbackRepo) {}

  async submit(input: SubmitFeedbackInput): Promise<{ id: number }> {
    if (!CATEGORIES.includes(input.category as FeedbackCategory)) {
      throw new ValidationError('invalid category');
    }
    const content = (input.content ?? '').trim();
    if (content.length === 0) throw new ValidationError('content is required');
    if (content.length > MAX_FEEDBACK_CONTENT) throw new ValidationError(`content exceeds ${MAX_FEEDBACK_CONTENT} characters`);

    const contact = trimmed(input.contact);
    if (contact && contact.length > MAX_FEEDBACK_CONTACT) throw new ValidationError('contact is too long');

    const installId = trimmed(input.installId);
    if (installId && installId.length > MAX_FEEDBACK_INSTALL_ID) throw new ValidationError('installId is too long');

    const replyKey = trimmed(input.replyKey);
    if (replyKey !== undefined) {
      if (!REPLY_KEY_PATTERN.test(replyKey)) throw new ValidationError('invalid replyKey');
      // 线程按 install_id + 哈希匹配：缺 installId 的 replyKey 永远读不回，直接拒绝。
      if (!installId) throw new ValidationError('replyKey requires installId');
    }

    const appVersion = trimmed(input.appVersion);
    if (appVersion && appVersion.length > MAX_FEEDBACK_APP_VERSION) throw new ValidationError('appVersion is too long');

    const os = trimmed(input.os);
    if (os && os.length > MAX_FEEDBACK_OS) throw new ValidationError('os is too long');

    const id = await this.repo.create({
      userId: input.userId,
      installId: installId ?? null,
      replyKeyHash: replyKey ? hashReplyKey(replyKey) : null,
      category: input.category as FeedbackCategory,
      content,
      contact: contact ?? null,
      appVersion: appVersion ?? null,
      os: os ?? null,
      sourceIp: input.sourceIp ?? null,
    });
    return { id };
  }

  /**
   * 扩展可见线程 = 匿名凭证匹配的未关联账号反馈 ∪ 当前登录账号的反馈。
   * 两种凭证都缺失时返回空（不报错，避免区分「不存在」与「凭证错误」）。
   */
  async thread(input: ThreadInput): Promise<FeedbackThreadItem[]> {
    const installId = trimmed(input.installId);
    const replyKey = trimmed(input.replyKey);
    const anonymous = installId && replyKey && REPLY_KEY_PATTERN.test(replyKey)
      ? { installId, replyKeyHash: hashReplyKey(replyKey) }
      : undefined;
    if (!anonymous && input.userId === null) return [];
    return this.repo.listThread({
      ...(anonymous ? { anonymous } : {}),
      ...(input.userId !== null ? { userId: input.userId } : {}),
      limit: MAX_THREAD_ITEMS,
    });
  }
}

function trimmed(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** 运营状态流转的合法性校验。 */
export function assertFeedbackStatus(status: string): FeedbackStatus {
  if (!STATUSES.includes(status as FeedbackStatus)) throw new ValidationError('invalid status');
  return status as FeedbackStatus;
}
