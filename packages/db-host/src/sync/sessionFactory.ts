import { PersonalSyncSession } from './session.js';
import type { PersonalSyncClient } from './e2e/client.js';
import type { SyncRunResult } from './e2e/syncEngine.js';
import type { MementoLike } from './e2e/stateStore.js';
import type { DekStore } from './crypto/keyStore.js';
import type { ConnectionStore } from '../connection/connectionStore.js';
import type { CachedEntitlement } from './entitlementGate.js';

/**
 * 受控的内部 session 工厂（A5）。
 *
 * PersonalSyncSession **不**在 activate() 创建；仅经本工厂按需懒建。未解锁前不建立
 * SyncEngine/Coordinator、不发起任何 sync API 请求。登录态缺失时不产出 session。
 *
 * 阶段 A 不暴露任何面向用户的同步命令/菜单/Webview；本工厂仅由内部测试或阶段 B 接线调用。
 */

export interface SyncSessionFactoryDeps {
  /** 真值会话所需（阶段 B 才可能触发懒建）。 */
  readonly connectionStore: ConnectionStore;
  readonly dekStore: DekStore;
  readonly memento: MementoLike;
  /** 当前登录用户（未登录返回 undefined，工厂不建 session）。 */
  readonly getUserId: () => Promise<string | undefined>;
  readonly entitlement?: () => CachedEntitlement | undefined;
  /** 每轮后台 sync 结束（含失败）后回调；供扩展层刷树/更新状态栏。 */
  readonly onSyncResult?: (result: SyncRunResult | undefined) => void;
  /** 会话锁定态变化后同步回调；供命令门控 context 即时刷新。 */
  readonly onSessionState?: () => void;
  /** 受控建连接口：仅登录后调用。 */
  readonly createClient: () => PersonalSyncClient;
}

export class SyncSessionFactory {
  private session?: PersonalSyncSession;

  constructor(private readonly deps: SyncSessionFactoryDeps) {}

  /** 已建会话（可能处于锁定态）；未建返回 undefined。 */
  get current(): PersonalSyncSession | undefined {
    return this.session;
  }

  /**
   * 懒建/复用 session。登录态缺失时返回 undefined（不建、零请求）。
   * 幂等：同一 userId 复用；换号则丢弃旧 session 重建。
   */
  async ensureSession(): Promise<PersonalSyncSession | undefined> {
    const userId = await this.deps.getUserId();
    if (!userId) return undefined;
    if (this.session && this.session.uid === userId) return this.session;
    this.session = new PersonalSyncSession(
      userId,
      this.deps.memento,
      this.deps.dekStore,
      this.deps.connectionStore,
      this.deps.createClient(),
      { entitlement: this.deps.entitlement, onSyncResult: this.deps.onSyncResult, onSessionState: this.deps.onSessionState },
    );
    return this.session;
  }

  /** 登出：丢弃 session（并触发其 dispose），确保不残留 DEK/订阅。 */
  invalidate(): void {
    this.session?.dispose();
    this.session = undefined;
  }

  dispose(): void {
    this.invalidate();
  }
}
