import * as vscode from 'vscode';
import { l10n } from '../i18n';

/** 有运行中监控任务时显示 `$(pulse) N`，点击打开「后台任务」；没有任务时隐藏。 */
export class MonitorStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 88);
    this.item.command = 'devbelt.monitor.tasks';
  }

  update(running: number, total: number, executing: boolean): void {
    if (total === 0) {
      this.item.hide();
      return;
    }
    this.item.text = running > 0 ? `$(pulse) ${running}` : `$(debug-pause) ${total}`;
    this.item.tooltip = executing
      ? l10n('monitor.status.tooltip', { running, total })
      : l10n('monitor.status.otherWindow', { running, total });
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
