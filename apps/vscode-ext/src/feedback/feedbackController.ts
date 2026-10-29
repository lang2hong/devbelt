import { getOrCreateInstallId } from '../telemetry/installId';
import { getOrCreateReplyKey, readReplyKey, type SecretStoreLike } from './replyKey';

/**
 * 反馈状态与网络（侧边栏入口和独立面板共用一份）。
 *
 * - 提交：`POST /api/db/feedback`（无需登录；已登录时带 Bearer 关联账号）。
 * - 线程：`POST /api/db/feedback/thread`，凭证放 body；非实时，由调用方在合适时机触发。
 * - 未读：本地记录「已读到的最大回复 id」，不同步、不上报。
 *
 * 本文件不依赖 `vscode`，便于单测。
 */

/**
 * 已读到的最大回复 id 的本地存储键。
 *
 * 走 `lastSeenState`（账号作用域）时同一键在不同账号下各自记录；local 作用域
 * 键名不变，升级后不会把旧回复重新标成未读。回复 id 全局自增，若跨账号共享
 * 一个水位，A 标记已读会把 B 的未读徽标一起压掉。
 */
export const LAST_SEEN_REPLY_KEY = 'devbelt.feedback.lastSeenReplyId';

export interface FeedbackThreadReply { id: string; body: string; createTime: string }
export interface FeedbackThreadEntry {
  id: string;
  category: 'bug' | 'feature' | 'other';
  content: string;
  status: 'new' | 'triaged' | 'done' | 'rejected';
  createTime: string;
  replies: FeedbackThreadReply[];
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface FeedbackControllerDeps {
  serverUrl: string;
  globalState: MementoLike;
  /**
   * 已读水位的存储（账号作用域 memento）。缺省回退 `globalState`（旧调用方）。
   * 注意 `installId` 必须留在 `globalState`：匿名安装统计与匿名反馈身份是设备级的。
   */
  lastSeenState?: MementoLike;
  secrets: SecretStoreLike;
  extensionVersion: string;
  /** 平台标识（`process.platform/arch`），由调用方注入以便测试。 */
  os: string;
  /** 当前扩展 access token（未登录为 undefined）；仅用于可选关联账号。 */
  getAccessToken: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export type SubmitOutcome = 'ok' | 'rateLimited' | 'tooLarge' | 'failed';

export interface FeedbackSnapshot {
  items: FeedbackThreadEntry[];
  unread: number;
  lastSeen: string;
}

/** 回复 id 是十进制字符串（BIGINT），按数值比较。 */
function maxReplyId(items: FeedbackThreadEntry[]): bigint {
  let max = 0n;
  for (const i of items) for (const r of i.replies) {
    try { const v = BigInt(r.id); if (v > max) max = v; } catch { /* 忽略非数字 id */ }
  }
  return max;
}

export function countUnread(items: FeedbackThreadEntry[], lastSeen: bigint): number {
  let n = 0;
  for (const i of items) for (const r of i.replies) {
    try { if (BigInt(r.id) > lastSeen) n++; } catch { /* ignore */ }
  }
  return n;
}

export class FeedbackController {
  private items: FeedbackThreadEntry[] = [];
  private inflight?: Promise<boolean>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: FeedbackControllerDeps) {}

  private get fetchFn(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /** 状态变化（线程刷新 / 标记已读）时回调；返回取消订阅函数。 */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* 监听方异常不影响其他监听方 */ }
    }
  }

  lastSeen(): bigint {
    try { return BigInt(this.seenState.get<string>(LAST_SEEN_REPLY_KEY) ?? '0'); } catch { return 0n; }
  }

  private get seenState(): MementoLike {
    return this.deps.lastSeenState ?? this.deps.globalState;
  }

  /**
   * 换号：立即清掉上一个账号的线程快照（面板/侧边栏不再显示旧账号的反馈与未读），
   * 再在后台按当前账号（或匿名凭证）重新拉取；拉取失败保持清空，不回显旧数据。
   */
  onAccountScopeChanged(): void {
    this.items = [];
    this.emit();
    void this.refresh();
  }

  snapshot(): FeedbackSnapshot {
    const lastSeen = this.lastSeen();
    return { items: this.items, unread: countUnread(this.items, lastSeen), lastSeen: lastSeen.toString() };
  }

  private authHeaders(): Record<string, string> {
    const token = this.deps.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async submit(input: {
    category: string;
    content: string;
    contact: string;
    /** 截图：服务端按文件头校验类型，客户端只负责读文件。 */
    images?: Array<{ fileName: string; dataBase64: string }>;
  }): Promise<SubmitOutcome> {
    const category = input.category === 'bug' || input.category === 'feature' || input.category === 'other' ? input.category : 'other';
    const content = input.content.trim();
    const contact = input.contact.trim().slice(0, 200);
    const replyKey = await getOrCreateReplyKey(this.deps.secrets);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await this.fetchFn(`${this.deps.serverUrl}/api/db/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this.authHeaders() },
        body: JSON.stringify({
          category,
          content,
          ...(contact ? { contact } : {}),
          installId: getOrCreateInstallId(this.deps.globalState),
          ...(replyKey ? { replyKey } : {}),
          appVersion: this.deps.extensionVersion,
          os: this.deps.os,
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        }),
        signal: controller.signal,
      });
      if (res.status === 201) return 'ok';
      if (res.status === 429) return 'rateLimited';
      if (res.status === 413) return 'tooLarge';
      return 'failed';
    } catch {
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拉取线程。并发调用合并为同一次请求（侧边栏和面板同时触发时只发一次）。
   * 返回 true = 已更新（含「没有凭证所以为空」）；false = 请求失败，保留旧数据。
   */
  refresh(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async doRefresh(): Promise<boolean> {
    const replyKey = await readReplyKey(this.deps.secrets);
    const token = this.deps.getAccessToken();
    if (!replyKey && !token) {
      this.items = [];
      this.emit();
      return true;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await this.fetchFn(`${this.deps.serverUrl}/api/db/feedback/thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this.authHeaders() },
        body: JSON.stringify({
          installId: getOrCreateInstallId(this.deps.globalState),
          ...(replyKey ? { replyKey } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { items?: FeedbackThreadEntry[] };
      this.items = Array.isArray(data.items) ? data.items : [];
      this.emit();
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把当前线程里的所有回复标为已读。 */
  async markAllRead(): Promise<void> {
    const max = maxReplyId(this.items);
    if (max > this.lastSeen()) {
      await this.seenState.update(LAST_SEEN_REPLY_KEY, max.toString());
      this.emit();
    }
  }
}
