import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { AuthService } from './authService';

/**
 * 设备管理（Vue 版）：展示当前用户全部设备（主机名/系统/版本/最后活跃 + 绑定状态），
 * 支持撤销设备（释放配额位）。
 *
 * 消息协议（与 webview/src/views/SessionView.vue 对齐）：
 *   webview → ext: ready | revoke{deviceId}
 *   ext → webview: init{mode:'session'} | devices{devices,currentDeviceId,canRevoke} | error{message}
 *
 * canRevoke 由扩展端按 planCode 下发：free=false（撤销按钮换成 Pro 标记），
 * 由 syncClient.throwIfDeviceLimit 在 server 端 403 兜底。
 */
export class SessionView extends BaseWebView {
  private static current?: SessionView;
  private initSent = false;
  private readonly auth: AuthService;

  private constructor(auth: AuthService) {
    super('dbclient.sessions', l10n('sessions.title'));
    this.auth = auth;
  }

  static open(auth: AuthService): void {
    if (SessionView.current) {
      SessionView.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    SessionView.current = new SessionView(auth);
  }

  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type === 'ready') {
      if (!this.initSent) {
        this.initSent = true;
        this.post({ type: 'init', mode: 'session' });
        return;
      }
      await this.refresh();
      return;
    }
    if (msg?.type === 'revoke' && msg.deviceId) {
      try {
        await this.auth.client.revokeDevice(String(msg.deviceId));
        await this.refresh();
      } catch (e) {
        this.post({ type: 'error', message: (e as Error).message });
      }
      return;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const { devices, currentDeviceId } = await this.auth.client.listDevices();
      this.post({ type: 'devices', devices, currentDeviceId, canRevoke: this.auth.getCachedPlan()?.code !== 'free' });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (SessionView.current === this) SessionView.current = undefined;
  }
}