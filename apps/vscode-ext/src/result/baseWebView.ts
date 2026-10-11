import * as vscode from 'vscode';
import { getWebviewHtml } from '../webview/html';
import { diagError } from '../utils/diagnostics';
import { isZh } from '../i18n';
import type { WebviewErrorMessage, WebviewInitMessage, WebviewMessage } from './protocol';

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
  /** 「两次 ready」协议状态；面板重载时按 webview 加载轮次重置。 */
  protected initSent = false;
  private currentLoad?: string;
  /** 面板已销毁：之后 post 一律短路（postMessage 到已销毁 webview 无意义且会噪声报错）。 */
  private panelDisposed = false;

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
    this.msgDisp = this.panel.webview.onDidReceiveMessage((msg) => {
      // 新一轮 webview 加载（面板重载）：重置两次 ready 状态，否则扩展会把重载后的
      // 第一个 ready 当成「第二次」，给尚未挂载的目标视图推数据 → 消息丢失、面板卡死。
      if (msg && typeof msg.__load === 'string' && msg.__load !== this.currentLoad) {
        this.currentLoad = msg.__load;
        this.initSent = false;
      }
      void this.handleMessage(msg).catch((e) => {
        diagError('webview message handler', String(e));
        // 统一错误边界：子类未捕获时也给用户可见反馈，而不是「点了没反应」。
        try {
          const err: WebviewErrorMessage = { type: 'error', message: (e as Error)?.message ?? String(e) };
          this.post(err);
        } catch { /* panel disposed */ }
      });
    });
    this.panelDisp = this.panel.onDidDispose(() => this.onDispose());
  }

  static init(extensionUri: vscode.Uri): void {
    BaseWebView._extensionUri = extensionUri;
  }

  /** 子类实现消息处理 */
  protected abstract handleMessage(msg: any): Promise<void>;

  /**
   * 向 webview 发消息。
   *
   * `init` 消息统一补上 `isZh`：webview 拿不到 `vscode.env` / 配置，语言只能由
   * 扩展端下发。在基类单点注入，11 个视图都不必各自记得传（此前只有
   * connectionForm 与 userForm 传了，其余视图因此永远是英文）。
   * 子类若已显式给出 isZh 则保留其值。
   */
  protected post(msg: WebviewMessage | WebviewInitMessage): void {
    if (this.panelDisposed) return;
    const payload = msg && msg.type === 'init' && (msg as WebviewInitMessage).isZh === undefined
      ? { ...msg, isZh: isZh() }
      : msg;
    void this.panel.webview.postMessage(payload);
  }

  /** dispose 面板 */
  dispose(): void {
    this.panel.dispose();
  }

  /** 聚焦/前置该面板（同键面板复用时不重复创建）。 */
  reveal(): void {
    this.panel.reveal();
  }

  /** 面板销毁回调（子类可 override 做清理） */
  protected onDispose(): void {
    this.panelDisposed = true;
    this.msgDisp.dispose();
    this.panelDisp.dispose();
  }
}
