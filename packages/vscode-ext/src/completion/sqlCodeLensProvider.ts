import * as vscode from 'vscode';

/**
 * SQL CodeLens 提供者。
 *
 * 在每段 SQL 语句（分号分隔）上方显示 "▶ Run" 按钮。
 * 点击后触发 dbclient.runStatement 命令执行对应 SQL 段。
 *
 * 设计模式：CodeLensProvider（VSCode 扩展点）
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {

  async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();

    // 按分号拆分 SQL 段（简单解析，不处理字符串内的分号）
    const segments = this.splitStatements(text);
    for (const seg of segments) {
      if (!seg.sql.trim()) continue;
      const range = new vscode.Range(
        document.positionAt(seg.start),
        document.positionAt(seg.end),
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) Run SQL',
          command: 'dbclient.runStatement',
          arguments: [seg.sql],
        }),
      );
    }
    return lenses;
  }

  /** 拆分 SQL 语句（按分号，忽略字符串内分号） */
  private splitStatements(text: string): { sql: string; start: number; end: number }[] {
    const result: { sql: string; start: number; end: number }[] = [];
    let start = 0;
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
      else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
      else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
      else if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
        const sql = text.slice(start, i + 1).trim();
        if (sql) result.push({ sql, start, end: i + 1 });
        start = i + 1;
      }
    }
    // 最后一段（无分号结尾）
    const last = text.slice(start).trim();
    if (last) result.push({ sql: last, start, end: text.length });

    return result;
  }
}
