import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { l10n } from '../i18n';
import type { AuthService } from './authService';

/**
 * 设备管理（Vue 版）：展示当前用户全部设备（平台/客户端版本/最后活跃 + 状态），
 * 支持撤销本人设备。
 *
 * 消息协议（与 webview/src/views/SessionView.vue 对齐）：
 *   webview → ext: ready | revoke{deviceId}
 *   ext → webview: init{mode:'session'} | devices{devices,canRevoke} | error{message}
 *
 * 设备经 /api/db/personal/devices 管理：Free 无设备配额（maxDevices=0），撤销本人设备恒允许，
 * 故 canRevoke 恒为 true；无 plan.features 位图、无 throwIfDeviceLimit 门禁。
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
      void this.auth.refreshEntitlement();
      const { devices } = await this.auth.client.listDevices();
      this.post({ type: 'devices', devices, canRevoke: true });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  protected onDispose(): void {
    super.onDispose();
    if (SessionView.current === this) SessionView.current = undefined;
  }
}
