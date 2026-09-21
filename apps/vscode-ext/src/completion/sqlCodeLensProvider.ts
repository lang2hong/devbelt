import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import { splitSqlWithRanges } from '../utils/sql';
import { dialectScanOptions } from '../utils/sqlDialectOptions';

/**
 * SQL CodeLens 提供者。
 *
 * 在每段 SQL 语句（分号分隔）上方显示 "▶ Run" 按钮。
 * 点击后触发 devbelt.runStatement 命令执行对应 SQL 段。
 *
 * 语句切分复用 `utils/sql.splitSqlWithRanges`，且必须传入与执行侧一致的方言
 * 选项：若 CodeLens 用默认（非 MySQL）切分，MySQL 文档里 `SELECT 1 # note; DROP`
 * 会把 `#` 注释内的分号切开，多出一个 "Run SQL" 并把 `DROP` 片段交给执行命令。
 * 方言由注入的 `resolveDbType(documentUri)` 解析（扩展侧接 ConnectionContext）。
 * 连接已建时优先用 `resolveScanOptions(documentUri)`（含 MySQL NO_BACKSLASH_ESCAPES），
 * 保证切分与实际执行同源。
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  constructor(
    private readonly resolveDbType?: (uri: string) => DatabaseType | undefined,
    private readonly resolveScanOptions?: (uri: string) => SqlScanOptions | undefined,
  ) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    const uri = document.uri.toString();
    const options = this.resolveScanOptions?.(uri) ?? dialectScanOptions(this.resolveDbType?.(uri));
    for (const seg of splitSqlWithRanges(document.getText(), options)) {
      const range = new vscode.Range(
        document.positionAt(seg.start),
        document.positionAt(seg.end),
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) Run SQL',
          command: 'devbelt.runStatement',
          arguments: [seg.sql],
        }),
      );
    }
    return lenses;
  }
}