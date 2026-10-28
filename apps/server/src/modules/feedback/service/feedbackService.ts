import { ValidationError } from '../../../domain/errors.js';
import type {
  FeedbackCategory,
  FeedbackStatus,
  IFeedbackRepo,
} from '../../../repository/interfaces/feedback.js';

export const MAX_FEEDBACK_CONTENT = 4000;
export const MAX_FEEDBACK_CONTACT = 200;
export const MAX_FEEDBACK_INSTALL_ID = 64;
export const MAX_FEEDBACK_APP_VERSION = 64;
export const MAX_FEEDBACK_OS = 100;

const CATEGORIES: readonly FeedbackCategory[] = ['bug', 'feature', 'other'];
const STATUSES: readonly FeedbackStatus[] = ['new', 'triaged', 'done', 'rejected'];

export interface SubmitFeedbackInput {
  userId: number | null;
  installId?: string;
  category: string;
  content: string;
  contact?: string;
  appVersion?: string;
  os?: string;
  sourceIp?: string;
}

/** 用户反馈：校验、裁剪与落库。路由负责限流，本层只做纯校验。 */
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

    const appVersion = trimmed(input.appVersion);
    if (appVersion && appVersion.length > MAX_FEEDBACK_APP_VERSION) throw new ValidationError('appVersion is too long');

    const os = trimmed(input.os);
    if (os && os.length > MAX_FEEDBACK_OS) throw new ValidationError('os is too long');

    const id = await this.repo.create({
      userId: input.userId,
      installId: installId ?? null,
      category: input.category as FeedbackCategory,
      content,
      contact: contact ?? null,
      appVersion: appVersion ?? null,
      os: os ?? null,
      sourceIp: input.sourceIp ?? null,
    });
    return { id };
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