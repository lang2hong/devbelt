import * as vscode from 'vscode';
import { getWebviewHtml } from '../webview/html';
import { diagError } from '../utils/diagnostics';

/**
 * Webview 面板基类：统一处理 panel 创建、HTML 注入、消息监听器 dispose。
 *
 * 子类只需：
 *   1. 调用 super(viewType, title, extensionUri)
 *   2. 实现 handleMessage(msg)
 *   3. 可选 post(msg) 向 webview 发消息
 */
export abstract class BaseWebView {
  protected static _extensionUri: vscode.Uri;
  protected readonly panel: vscode.WebviewPanel;
  private readonly msgDisp: vscode.Disposable;
  private readonly panelDisp: vscode.Disposable;

  constructor(
    viewType: string,
    title: string,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
    options?: vscode.WebviewOptions,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      viewType, title, viewColumn,
      { enableScripts: true, retainContextWhenHidden: true, ...options },
    );
    this.panel.webview.html = getWebviewHtml(this.panel.webview, BaseWebView._extensionUri);
    this.msgDisp = this.panel.webview.onDidReceiveMessage((msg) =>
      void this.handleMessage(msg).catch((e) => diagError('webview message handler', String(e))),
    );
    this.panelDisp = this.panel.onDidDispose(() => this.onDispose());
  }

  static init(extensionUri: vscode.Uri): void {
    BaseWebView._extensionUri = extensionUri;
  }

  /** 子类实现消息处理 */
  protected abstract handleMessage(msg: any): Promise<void>;

  /** 向 webview 发消息 */
  protected post(msg: any): void {
    void this.panel.webview.postMessage(msg);
  }

  /** dispose 面板 */
  dispose(): void {
    this.panel.dispose();
  }

  /** 面板销毁回调（子类可 override 做清理） */
  protected onDispose(): void {
    this.msgDisp.dispose();
    this.panelDisp.dispose();
  }
}
