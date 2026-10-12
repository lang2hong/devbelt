import * as vscode from 'vscode';
import { l10n } from '../i18n';

/** Alt+A 单发生成的结果（状态条展示 + "在 Chat 中细化"预填素材）。 */
export interface Nl2SqlStatusResult {
  /** 用户原始自然语言请求（选区文本或输入框）。 */
  request: string;
  sql: string;
  paraphrase: string;
  assumptions: string[];
  connId?: string;
  connName?: string;
  database?: string;
}

/**
 * NL2SQL 单发状态条（P9 S4）：`AI：N 条假设 · 复述`，点击执行
 * `devbelt.ai.nl2sqlDetails`（QuickPick 展示复述/假设 + "在 Chat 中细化"）。
 * 只存最近一次结果（内存），不持久化。
 */
export class AiStatusBar {
  private readonly item: vscode.StatusBarItem;
  private last?: Nl2SqlStatusResult;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = 'devbelt.ai.nl2sqlDetails';
  }

  show(result: Nl2SqlStatusResult): void {
    this.last = result;
    this.item.text = `$(sparkle) ${l10n('ai.status.summary', { count: result.assumptions.length })}`;
    this.item.tooltip = result.paraphrase || l10n('ai.status.details');
    this.item.show();
  }

  getLast(): Nl2SqlStatusResult | undefined {
    return this.last;
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}