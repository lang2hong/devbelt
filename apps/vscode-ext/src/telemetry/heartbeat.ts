import * as vscode from 'vscode';
import { getOrCreateInstallId } from './installId';

/**
 * 匿名安装心跳：每天最多一次，用于统计“安装（首次激活）”和“活跃安装”。
 *
 * 隐私边界：
 * - 仅在 `vscode.env.isTelemetryEnabled` 且 `devbelt.telemetry.enabled` 为 true 时发送；
 * - 只上报随机安装 ID、扩展版本、OS/arch、是否远程窗口；
 * - 不含邮箱、账号、连接信息、查询内容或 IP 地址。
 *
 * 可靠性：5 秒超时、失败静默、不重试；成功后才记录当天日期，失败会在下次激活重试。
 */
const LAST_HEARTBEAT_DAY_KEY = 'devbelt.telemetry.lastHeartbeatDay';
const HEARTBEAT_PATH = '/api/db/telemetry/heartbeat';

export interface InstallHeartbeatOptions {
  serverUrl: string;
  globalState: vscode.Memento;
  extensionVersion: string;
}

export async function maybeSendInstallHeartbeat(opts: InstallHeartbeatOptions): Promise<void> {
  if (!vscode.env.isTelemetryEnabled) return;

  const enabled = vscode.workspace.getConfiguration('devbelt').get<boolean>('telemetry.enabled', true);
  if (enabled !== true) return;

  const day = new Date().toISOString().slice(0, 10);
  if (opts.globalState.get<string>(LAST_HEARTBEAT_DAY_KEY) === day) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${opts.serverUrl}${HEARTBEAT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        installId: getOrCreateInstallId(opts.globalState),
        appVersion: opts.extensionVersion,
        os: process.platform,
        arch: process.arch,
        isRemote: vscode.env.remoteName !== undefined,
      }),
      signal: controller.signal,
    });
    if (res.status === 204) {
      await opts.globalState.update(LAST_HEARTBEAT_DAY_KEY, day);
    }
  } catch {
    // 遥测是尽力而为：失败不打扰用户，也不阻塞激活。
  } finally {
    clearTimeout(timer);
  }
}