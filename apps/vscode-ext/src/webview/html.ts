import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

/**
 * 生成 VSCode webview HTML（加载 Vite 构建的 Vue 应用）。
 *
 * CSP 策略：style-src 允许内联样式（Vue 注入），script-src 使用 nonce 防注入。
 */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'index.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'style.css'),
  );
  const nonce = getNonce();
  const csp = webview.cspSource;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'nonce-${nonce}' ${csp}; font-src ${csp};">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * 生成 CSP nonce。
 *
 * 必须用密码学随机源：`Math.random()` 是可预测的 PRNG，攻击者猜到 nonce
 * 即可让注入的 <script> 通过 CSP。base64 里的 `+/=` 对 CSP nonce 合法，无需替换。
 */
export function getNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * AI Chat 面板独立 HTML（P9 S3）：加载 `out/webview/aiChat.js`。
 *
 * 与 `getWebviewHtml`（共享 index.js + 视图 mode switch）并列：AI 面板按
 * §6.10 走独立入口，不进入 WebviewMode 分支。样式仍复用构建产出的 style.css
 * （cssCodeSplit=false 单文件）。
 */
export function getAiChatHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'aiChat.js'),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'style.css'),
  );
  const nonce = getNonce();
  const csp = webview.cspSource;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline' ${csp}; script-src 'nonce-${nonce}' ${csp}; font-src ${csp};">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
