import * as vscode from 'vscode';
import { SchemaDiffService } from '@db-client/core';
import { DbTreeNode } from '../tree/dbTreeNode';
import { wrapIdent, splitSqlStatements } from '../utils/sql';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm, openSqlDoc } from './shared';

export function registerDatabaseCommands(deps: Deps, sub: Sub): void {
  const { manager, treeProvider, connCtx } = deps;

  sub('dbclient.createDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('db.createPrompt') });
    if (!name) return;
    connCtx.setLast(node.conn);
    const session = await manager.connect(node.conn);
    await session.query.query(`CREATE DATABASE ${wrapIdent(node.conn, name)}`);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('db.created', { name }));
  });

  sub('dbclient.dropDatabase', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('db.dropConfirm', 'db.drop', node.label))) return;
    const session = await manager.connect(node.conn);
    await session.query.query(`DROP DATABASE ${wrapIdent(node.conn, node.label)}`);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('dbclient.importData', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    const uri = await vscode.window.showOpenDialog({
      filters: { 'SQL files': ['sql'], 'CSV files': ['csv'] },
      canSelectMany: false,
    });
    if (!uri?.[0]) return;
    const doc = await vscode.workspace.openTextDocument(uri[0]);
    const sql = doc.getText();
    const session = await manager.connect(node.conn);
    if (node.database) {
      try { await session.query.query(`USE ${wrapIdent(node.conn, node.database)}`); } catch { /* ignore */ }
    }
    const stmts = splitSqlStatements(sql);
    let done = 0;
    for (const stmt of stmts) {
      await session.query.query(stmt);
      done++;
    }
    vscode.window.showInformationMessage(l10n('import.done', { count: done }));
    treeProvider.refresh();
  });

  sub('dbclient.exportConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    connCtx.setLast(node.conn, node.database);
    const choice = await vscode.window.showQuickPick(
      [{ label: l10n('export.structureOnly'), value: false }, { label: l10n('export.structureData'), value: true }],
      { placeHolder: l10n('export.choose') },
    );
    if (!choice) return;
    const session = await manager.connect(node.conn);
    const parts: string[] = [];
    if (node.database) {
      const tables = await session.metadata.getTables(node.database);
      const dumps = await Promise.all(
        tables.map((t) => session.table.dumpSql(t.name, node.database, choice.value)),
      );
      parts.push(...dumps);
    } else {
      const dbs = await session.metadata.getDatabases();
      const dumps = await Promise.all(
        dbs.map(async (db) => {
          const tables = await session.metadata.getTables(db);
          return Promise.all(tables.map((t) => session.table.dumpSql(t.name, db, choice.value)));
        }),
      );
      parts.push(...dumps.flat());
    }
    await openSqlDoc(parts.join('\n\n'));
  });

  sub('dbclient.compareSchema', async (node: DbTreeNode) => {
    if (!node?.conn || !node?.database) return;
    const session = await manager.connect(node.conn);
    const targetDbs = (await session.metadata.getDatabases()).filter((d) => d !== node.database);
    if (!targetDbs.length) {
      vscode.window.showWarningMessage('No other databases to compare.');
      return;
    }
    const target = await vscode.window.showQuickPick(
      targetDbs.map((d) => ({ label: d, value: d })),
      { placeHolder: `Compare "${node.database}" with which database?` },
    );
    if (!target) return;

    const diffs = await SchemaDiffService.diff(session.metadata, node.database, session.metadata, target.value);
    const syncSql = await SchemaDiffService.generateSyncSql(diffs, target.value, session.table, node.database);
    const added = diffs.filter((d) => d.status === 'added').length;
    const removed = diffs.filter((d) => d.status === 'removed').length;
    const changed = diffs.filter((d) => d.status === 'changed').length;
    const header = `-- Diff: ${node.database} -> ${target.value} (${added} added, ${removed} removed, ${changed} changed)\n\n`;
    await openSqlDoc(header + syncSql);
  });
}
