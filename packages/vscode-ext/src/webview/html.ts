import * as vscode from 'vscode';

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

/** 生成随机 nonce（CSP 安全令牌） */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
