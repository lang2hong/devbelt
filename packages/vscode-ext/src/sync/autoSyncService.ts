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
      const status = await this.sync.tryAutoSync();
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
