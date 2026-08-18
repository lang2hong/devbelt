import type { SyncManager } from './syncManager';
import type { Event, Disposable } from '../utils/event';

export type AutoSyncMode = 'off' | 'reminder' | 'silent';

/**
 * 自动同步服务：
 *  - 启动时触发一次；
 *  - 本地数据变更防抖（3s）后触发；
 *  - 定时器（intervalMin>0）周期触发。
 *
 * 触发时按 `dbclient.sync.auto` 档位：
 *  - silent：用本机已记住的主密码静默 pull+push；无主密码则降级 reminder。
 *  - reminder：仅提示用户有未同步变更（不存主密码，零凭证）。
 *  - off：不动作。
 */
export class AutoSyncService {
  private readonly disposables: Disposable[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** silent 同步是否正在进行（重入保护，见 trigger） */
  private running = false;
  /** 当前失败重试计数（成功后归零） */
  private retryCount = 0;
  private static readonly MAX_RETRIES = 3;
  /** 失败退避基数 30s，每次翻倍 */
  private static readonly RETRY_BASE_MS = 30_000;

  constructor(
    private readonly sync: SyncManager,
    private readonly getMode: () => AutoSyncMode,
    private readonly getIntervalMin: () => number,
    private readonly onStoreChanged: Event<void>,
    private readonly onReminder: () => void,
    private readonly onSynced: () => void,
    private readonly isLoggedIn: () => boolean,
  ) {}

  start(): void {
    this.disposables.push(this.onStoreChanged(() => this.scheduleDebounced()));
    void this.trigger();
    this.resetInterval();
  }

  /** 配置变更后重启（重建定时器） */
  restart(): void {
    this.clearTimers();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.start();
  }

  private resetInterval(): void {
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = undefined; }
    const min = this.getIntervalMin();
    if (min > 0) {
      this.intervalTimer = setInterval(() => void this.trigger(), min * 60_000);
    }
  }

  private scheduleDebounced(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.trigger();
    }, 3000);
  }

  private async trigger(): Promise<void> {
    if (!this.isLoggedIn()) return;
    const mode = this.getMode();
    if (mode === 'off') return;
    if (mode === 'silent') {
      // 上一轮还没跑完就直接放弃这一轮。
      //
      // 重叠是常态而非边缘情况：一次 tryAutoSync 是 7 个串行请求（1 pull +
      // 5 push + 1 usage），每个 section 还要做一次 600k 轮 PBKDF2（约 0.5s），
      // 轻易超过 3 秒防抖窗口。而重叠的代价不只是白跑一趟 —— 两轮会各自撞上
      // access token 过期，各自拿**同一个** refresh token 去续期，服务端的
      // 「查—撤销—签发」三步非原子，并发进去要么泄漏一个孤儿 token，要么命中
      // 重用检测把用户从所有设备踢下线。
      //
      // 丢掉这一轮是安全的：下一次变更或下一个周期还会触发，而同步本身是
      // 幂等的全量比对，不存在「漏掉某次变更」。
      if (this.running) return;
      this.running = true;
      let status: 'ok' | 'no-master' | 'error';
      try {
        status = await this.sync.tryAutoSync();
      } catch {
        // tryAutoSync 内部已 catch，理论上不会走到这里。但所有调用点都是
        // `void this.trigger()`，一旦漏出异常就是未捕获的 promise 拒绝 ——
        // 在扩展宿主里表现为一条无人处理的错误日志。语义上「抛了」和
        // 「返回 error」没有区别，统一按 error 处理。
        status = 'error';
      } finally {
        // 必须放 finally：guard 不释放的话，一次意外之后自动同步就永久停摆，
        // 直到用户重启 VS Code。
        this.running = false;
      }
      if (status === 'ok') {
        this.retryCount = 0;
        this.onSynced();
      } else if (status === 'no-master') {
        this.retryCount = 0;
        this.onReminder();
      } else {
        // 'error'：网络/服务端瞬时故障，退避重排直至成功
        this.onReminder();
        this.scheduleRetry();
      }
    } else {
      this.onReminder();
    }
  }

  /** 失败退避重排：30s → 60s → 120s，上限 3 次 */
  private scheduleRetry(): void {
    if (this.retryCount >= AutoSyncService.MAX_RETRIES) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = AutoSyncService.RETRY_BASE_MS * 2 ** this.retryCount;
    this.retryCount++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.trigger();
    }, delay);
  }

  private clearTimers(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = undefined; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  }

  dispose(): void {
    this.clearTimers();
    this.disposables.forEach((d) => d.dispose());
  }
}
