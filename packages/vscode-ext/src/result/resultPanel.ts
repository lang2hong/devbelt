import * as vscode from 'vscode';
import type { QueryResult } from '@db-client/core';

/**
 * 结果面板管理器：负责创建/复用承载 SQL 结果表格的 webview。
 * 同一时刻只保留一个结果面板，后者打开时复用并刷新内容。
 */
export class ResultPanel {
  private static current?: ResultPanel;
  private readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      if (ResultPanel.current === this) ResultPanel.current = undefined;
    });
  }

  /** 获取或创建结果面板实例 */
  static show(): ResultPanel {
    if (ResultPanel.current) {
      ResultPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return ResultPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.result',
      'Query Result',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new ResultPanel(panel);
    ResultPanel.current = instance;
    return instance;
  }

  /** 渲染查询结果到表格 */
  render(result: QueryResult): void {
    this.panel.webview.postMessage({ type: 'render', result });
  }

  /** 展示加载/错误状态 */
  showError(message: string): void {
    this.panel.webview.postMessage({ type: 'error', message });
  }

  /** 初始化 webview 内容（HTML + 脚本） */
  bindHtml(html: string): void {
    this.panel.webview.html = html;
  }
}

/** 生成结果表格 webview 的 HTML（脚本内联） */
export function resultHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); margin: 0; padding: 0; }
    #meta { padding: 8px 12px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #error { padding: 12px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .table-wrap { overflow: auto; max-height: calc(100vh - 40px); }
    table { border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 10px; text-align: left; white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); }
    td { max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  </style>
</head>
<body>
  <div id="meta"></div>
  <div id="error" style="display:none"></div>
  <div class="table-wrap"><table id="grid"></table></div>
  <script>
    const vscode = acquireVsCodeApi();
    const grid = document.getElementById('grid');
    const metaEl = document.getElementById('meta');
    const errorEl = document.getElementById('error');

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'error') {
        errorEl.style.display = 'block';
        errorEl.textContent = msg.message;
        grid.innerHTML = '';
        metaEl.textContent = '';
        return;
      }
      if (msg.type === 'render') {
        const r = msg.result;
        errorEl.style.display = 'none';
        metaEl.textContent = r.rows.length + " row(s) in " + (r.costTime/1000).toFixed(3) + "s";
        grid.innerHTML = '';
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        (r.fields || []).forEach(f => {
          const th = document.createElement('th');
          th.textContent = f.name;
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        grid.appendChild(thead);
        const tbody = document.createElement('tbody');
        r.rows.forEach(row => {
          const tr = document.createElement('tr');
          (r.fields || []).forEach(f => {
            const td = document.createElement('td');
            let v = row[f.name];
            if (v === null || v === undefined) v = 'NULL';
            else if (typeof v === 'object') v = JSON.stringify(v);
            td.textContent = v;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        grid.appendChild(tbody);
      }
    });
  </script>
</body>
</html>`;
}