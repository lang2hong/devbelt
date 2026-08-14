import * as vscode from 'vscode';
import { splitSqlWithRanges } from '../utils/sql';

/**
 * SQL CodeLens 提供者。
 *
 * 在每段 SQL 语句（分号分隔）上方显示 "▶ Run" 按钮。
 * 点击后触发 dbclient.runStatement 命令执行对应 SQL 段。
 *
 * 语句切分复用 `utils/sql.splitSqlWithRanges`：此前这里自带一份不处理注释的
 * 实现，`-- note; more` 里的分号会把语句切成两半，CodeLens 显示的段与
 * queryRunner 实际执行的段（走 splitSqlStatements）对不上。
 *
 * 设计模式：CodeLensProvider（VSCode 扩展点）
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {

  async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    for (const seg of splitSqlWithRanges(document.getText())) {
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
}
