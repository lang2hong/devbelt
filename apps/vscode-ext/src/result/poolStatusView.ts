import { BaseWebView } from './baseWebView';
import type { ConnectionManager } from '../connection/connectionManager';

const REFRESH_INTERVAL_MS = 5000;

/**
 * 连接池状态面板：轮询 ConnectionManager.getPoolStats()，展示会话占用与空闲回收阈值。
 *
 * 消息协议（与 webview/src/views/PoolStatusView.vue 对齐）：
 *   webview → ext: ready
 *   ext → webview: init{mode:'poolStatus'} | stats{stats}
 */
export class PoolStatusView extends BaseWebView {
  private static current?: PoolStatusView;
  private initSent = false;
  private timer?: ReturnType<typeof setInterval>;

  private constructor(private readonly manager: ConnectionManager) {
    super('devbelt.poolStatus', 'Connection Pool');
  }

  static open(manager: ConnectionManager): void {
    if (PoolStatusView.current) PoolStatusView.current.dispose();
    PoolStatusView.current = new PoolStatusView(manager);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type !== 'ready') return;
    // 首个 ready 来自默认挂载的 QueryView，需先切模式；切换后新视图会再发一次 ready
    if (!this.initSent) {
      this.initSent = true;
      this.post({ type: 'init', mode: 'poolStatus' });
      return;
    }
    this.sendStats();
    if (!this.timer) {
      this.timer = setInterval(() => this.sendStats(), REFRESH_INTERVAL_MS);
    }
  }

  private sendStats(): void {
    this.post({ type: 'stats', stats: this.manager.getPoolStats() });
  }

  protected onDispose(): void {
    super.onDispose();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (PoolStatusView.current === this) PoolStatusView.current = undefined;
  }
}
