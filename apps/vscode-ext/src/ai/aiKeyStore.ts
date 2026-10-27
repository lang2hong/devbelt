import * as vscode from 'vscode';
import { accountScope, onAccountScopeChange, scopedKey } from '../sync/accountScope';

/** SecretStorage 键：自带 Key 模式的 apiKey（后续多 provider 可扩为 `devbelt.ai.<providerId>.apiKey`）。 */
export const AI_API_KEY_SECRET = 'devbelt.ai.openai.apiKey';

/**
 * AI apiKey 的 SecretStorage 封装（P9 S3）。
 *
 * 镜像 AuthService 的 secretCache + onDidChange 模式：
 * - 读取带内存缓存，`onDidChange`（其他窗口写入/清除）时失效重读；
 * - 写/删后立刻失效缓存并广播 `onDidChange`，面板可据此刷新"已配置"状态；
 * - apiKey 只落 SecretStorage：不进 Memento/日志/审计/webview。
 */
export class AiKeyStore {
  private cached: string | undefined;
  private loaded = false;
  private readonly sub: vscode.Disposable;
  private readonly scopeSub: { dispose(): void };
  private readonly emitter = new vscode.EventEmitter<void>();

  /** 配置变更（设置/清除 apiKey）时触发。 */
  readonly onDidChange: vscode.Event<void>;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.onDidChange = this.emitter.event;
    this.sub = secrets.onDidChange((e) => {
      // 同前缀的键都要失效：账号作用域键、以及「已清除」标记。
      if (e.key.startsWith(AI_API_KEY_SECRET)) this.invalidateCache();
    });
    // 切换账号不会触发 SecretStorage 变更事件：必须显式丢弃上一个账号的缓存 Key。
    this.scopeSub = onAccountScopeChange(() => this.invalidateCache());
  }

  /** 读取 apiKey（缓存优先；空串表示未配置）。 */
  /** 当前账号下的 SecretStorage 键；未登录沿用旧键（B1：读时复制）。 */
  private secretKey(): string {
    return scopedKey(AI_API_KEY_SECRET);
  }

  /** 「该账号主动清除过 Key」标记：防止下次读取又从 local 复制回来。 */
  private clearedKey(): string {
    return scopedKey(`${AI_API_KEY_SECRET}.cleared`);
  }

  async getApiKey(): Promise<string | undefined> {
    if (this.loaded) return this.cached;
    const key = this.secretKey();
    let stored = await this.secrets.get(key);
    if (stored === undefined && key !== AI_API_KEY_SECRET && accountScope() !== 'local') {
      // B1：账号里还没有 Key 时，把本机原有的 Key 复制一份过去，原值保留。
      // 但用户在该账号里主动清除过就不再复制（否则「清除」永远不生效）。
      const cleared = await this.secrets.get(this.clearedKey());
      if (cleared !== '1') {
        stored = await this.secrets.get(AI_API_KEY_SECRET);
        if (stored !== undefined) await this.secrets.store(key, stored);
      }
    }
    this.cached = stored && stored.trim() ? stored.trim() : undefined;
    this.loaded = true;
    return this.cached;
  }

  /** 同步读取缓存（未加载过返回 undefined；同步出站序列化用，不触发 SecretStorage 读取）。 */
  peekApiKey(): string | undefined {
    return this.loaded ? this.cached : undefined;
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      await this.clearApiKey();
      return;
    }
    await this.secrets.store(this.secretKey(), trimmed);
    await this.secrets.delete(this.clearedKey());
    this.invalidateCache();
  }

  async clearApiKey(): Promise<void> {
    // 只清当前账号的 Key，其他账号的保留；标记「已清除」避免读时复制把它带回来。
    await this.secrets.delete(this.secretKey());
    await this.secrets.store(this.clearedKey(), '1');
    this.invalidateCache();
  }

  /** 本窗口写/删后失效缓存并广播（SecretStorage 的 onDidChange 亦会触发，幂等）。 */
  private invalidateCache(): void {
    this.loaded = false;
    this.cached = undefined;
    this.emitter.fire();
  }

  dispose(): void {
    this.sub.dispose();
    this.scopeSub.dispose();
    this.emitter.dispose();
  }
}