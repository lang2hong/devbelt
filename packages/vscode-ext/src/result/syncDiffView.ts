import { BaseWebView } from './baseWebView';
import type { ApplyStrategy } from '../sync/syncManager';
import type { MergePlan } from '../sync/mergePlan';

/**
 * 同步合并差异预览视图：展示 pull/push 前的合并计划，用户选定策略后应用。
 *
 * 视图不绑定具体同步动作（pull 还是 push）：由调用方注入 onStrategy 回调，
 * 收到 webview 的 apply(strategy) 时执行。主密码仅在调用方（扩展进程）持有，
 * 不发往 webview；webview 仅发送 apply(local/remote/merge) 或 cancel 意图。
 */
export class SyncDiffView extends BaseWebView {
  private static current?: SyncDiffView;
  private initSent = false;

  private constructor(
    private readonly onStrategy: (strategy: ApplyStrategy) => Promise<void>,
    private readonly plan: MergePlan,
    private readonly onApplied?: () => void | Promise<void>,
  ) {
    super('dbclient.syncDiff', 'Sync Diff Preview');
  }

  static open(
    onStrategy: (strategy: ApplyStrategy) => Promise<void>,
    plan: MergePlan,
    onApplied?: () => void | Promise<void>,
  ): void {
    if (SyncDiffView.current) SyncDiffView.current.dispose();
    const view = new SyncDiffView(onStrategy, plan, onApplied);
    SyncDiffView.current = view;
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg.type === 'apply') {
      try {
        await this.onStrategy((msg.strategy as ApplyStrategy) || 'merge');
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