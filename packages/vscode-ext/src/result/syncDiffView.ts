import { BaseWebView } from './baseWebView';
import type { SyncManager } from '../sync/syncManager';
import type { MergePlan } from '../sync/mergePlan';

/**
 * 同步合并差异预览视图：展示 pull 前的合并计划，用户确认后应用。
 * 主密码仅在此实例（扩展进程）持有，不发往 webview；webview 仅发送 apply/cancel 意图。
 */
export class SyncDiffView extends BaseWebView {
  private static current?: SyncDiffView;
  private initSent = false;

  private constructor(
    private readonly sync: SyncManager,
    private readonly plan: MergePlan,
    private readonly onApplied?: () => void | Promise<void>,
  ) {
    super('dbclient.syncDiff', 'Sync Diff Preview');
  }

  static open(
    sync: SyncManager,
    plan: MergePlan,
    onApplied?: () => void | Promise<void>,
  ): void {
    if (SyncDiffView.current) SyncDiffView.current.dispose();
    const view = new SyncDiffView(sync, plan, onApplied);
    SyncDiffView.current = view;
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'apply') {
      try {
        await this.sync.applyPreviewedPull();
        this.post({ type: 'applied' });
        await this.onApplied?.();
        this.dispose();
      } catch (err) {
        this.post({ type: 'error', message: (err as Error).message });
      }
      return;
    }
    if (msg.type === 'cancel') {
      this.dispose();
      return;
    }
    if (msg.type !== 'ready') return;
    // 第一次 ready 来自 App.vue 默认 QueryView：切到 syncDiff 模式
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'syncDiff' });
      return;
    }
    // 第二次 ready 来自 SyncDiffView.vue 挂载：推送差异计划
    this.post({ type: 'plan', plan: this.plan });
  }

  protected onDispose(): void {
    super.onDispose();
    if (SyncDiffView.current === this) SyncDiffView.current = undefined;
  }
}
