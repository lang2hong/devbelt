import * as vscode from 'vscode';
import { writeFile, chmod } from 'node:fs/promises';
import { l10n } from '../i18n';
import { diagWarn } from '../utils/diagnostics';
import type { AuthenticatorStore } from './store';

/**
 * 导出验证器条目为 otpauth URI 文本文件（主进程独占文件 IO，不把内容下发 webview）。
 *
 * 文件含明文 TOTP 密钥，导出前弹 modal 警告确认；写入遵循 connection 导出的安全约定：
 * `file` scheme 以 0600 写入（含覆盖已存在宽松权限文件时的显式 chmod），非 file scheme
 * 回退到 `workspace.fs`。命令 handler 与 provider 的 `export` 消息共用本函数。
 */
export async function exportAuthenticatorEntries(store: AuthenticatorStore): Promise<void> {
  const proceed = l10n('authenticator.export.proceed');
  const ok = await vscode.window.showWarningMessage(
    l10n('authenticator.export.warning'),
    { modal: true },
    proceed,
  );
  if (ok !== proceed) return;

  const text = store.exportAll();
  if (!text) {
    void vscode.window.showInformationMessage(l10n('authenticator.export.empty'));
    return;
  }
  const count = text.trimEnd().split('\r\n').length;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file('devbelt-authenticator.txt'),
    filters: { otpauth: ['txt'] },
  });
  if (!uri) return;

  if (uri.scheme === 'file') {
    await writeFile(uri.fsPath, text, { encoding: 'utf8', mode: 0o600 });
    await chmod(uri.fsPath, 0o600).catch((e) => diagWarn('chmod authenticator export failed', String(e)));
  } else {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }
  void vscode.window.showInformationMessage(l10n('authenticator.export.done', { count }));
}
