import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { ConnectionForm } from '../connection/connectionForm';
import type { SavedConnection } from '../connection/connectionStore';
import { l10n } from '../i18n';
import type { Deps, Sub } from './shared';
import { confirm } from './shared';

async function queryServerVersion(session: any, dbType: string): Promise<string> {
  try {
    if (dbType === DatabaseType.PG) {
      const r = await session.query.query('SHOW server_version');
      return String((r.rows[0] && Object.values(r.rows[0])[0]) ?? '').trim();
    }
    if (dbType === DatabaseType.SQLITE) {
      const r = await session.query.query('select sqlite_version() AS v');
      return String((r.rows[0] && Object.values(r.rows[0])[0]) ?? '').trim();
    }
    const r = await session.query.query('SELECT VERSION() AS v');
    return String((r.rows[0] && Object.values(r.rows[0])[0]) ?? '').trim();
  } catch { return ''; }
}

export function registerConnectionCommands(deps: Deps, sub: Sub): void {
  const { store, manager, treeProvider, connCtx } = deps;

  sub('dbclient.addConnection', (node?: DbTreeNode) => {
    const gid = node?.kind === NodeKind.Group ? node.groupId : undefined;
    ConnectionForm.open(store, () => treeProvider.refresh(), gid);
  });

  sub('dbclient.editConnection', (node: DbTreeNode) => {
    if (node?.conn) ConnectionForm.open(store, () => treeProvider.refresh(), undefined, node.conn);
  });

  sub('dbclient.deleteConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('conn.deleteConfirm', 'table.delete', node.conn.name || node.conn.host))) return;
    await store.remove(node.conn.id);
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('dbclient.openConnection', async (conn: SavedConnection) => {
    if (!conn?.id) return;
    treeProvider.markOpen(conn.id);
    connCtx.setLast(conn);
    treeProvider.refresh();
    try {
      const session = await manager.connect(conn);
      manager.markExplicit(conn.id);
      const ver = await queryServerVersion(session, conn.dbType);
      treeProvider.setConnVersion(conn.id, `${conn.dbType} ${ver}`.trim());
      treeProvider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Open connection failed: ${(err as Error).message}`);
    }
  });

  sub('dbclient.closeConnection', (node: DbTreeNode) => {
    if (!node?.conn) return;
    manager.disposeConn(node.conn.id);
    treeProvider.markClosed(node.conn.id);
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('conn.closed', { name: node.conn.name || node.conn.host }));
  });

  sub('dbclient.refreshConnection', (node: DbTreeNode) => {
    if (node?.conn) manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('dbclient.refresh', () => treeProvider.refresh());

  sub('dbclient.exportConnections', async (node?: DbTreeNode) => {
    const all = store.list();
    if (!all.length) {
      vscode.window.showInformationMessage(l10n('conn.exportNone'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      all.map((c) => ({ label: c.name || c.host || c.id, value: c.id, picked: !node || node.conn?.id === c.id })),
      { canPickMany: true, placeHolder: l10n('conn.exportPick') },
    );
    if (!picked?.length) return;
    const includeSecrets = await vscode.window.showQuickPick(
      [
        { label: l10n('conn.exportNoSecrets'), value: false },
        { label: l10n('conn.exportWithSecrets'), value: true },
      ],
      { placeHolder: l10n('conn.exportSecretsPrompt') },
    );
    if (includeSecrets === undefined) return;
    if (includeSecrets.value) {
      const ok = await vscode.window.showWarningMessage(
        l10n('conn.exportSecretsWarning'),
        { modal: true },
        l10n('conn.exportContinue'),
      );
      if (ok !== l10n('conn.exportContinue')) return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('db-client-connections.json'),
      filters: { JSON: ['json'] },
    });
    if (!uri) return;
    const selected = all.filter((c) => picked.some((p) => p.value === c.id));
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets: includeSecrets.value,
      connections: selected.map((c) => {
        const out: Record<string, unknown> = { ...c };
        if (!includeSecrets.value) {
          delete out.password;
          delete out.sshPassword;
          delete out.sshPassphrase;
        }
        return out;
      }),
    };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    vscode.window.showInformationMessage(l10n('conn.exportDone', { count: selected.length }));
  });

  sub('dbclient.importConnections', async () => {
    const uri = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      openLabel: l10n('conn.importOpen'),
    });
    if (!uri?.[0]) return;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri[0])).toString('utf8');
    let payload: { version?: number; includeSecrets?: boolean; connections?: SavedConnection[] };
    try {
      payload = JSON.parse(text);
    } catch {
      vscode.window.showErrorMessage(l10n('conn.importInvalid'));
      return;
    }
    if (!Array.isArray(payload.connections)) {
      vscode.window.showErrorMessage(l10n('conn.importInvalid'));
      return;
    }
    let imported = 0;
    for (const conn of payload.connections) {
      if (!conn?.name && !conn?.host) continue;
      const existing = store.get(conn.id);
      const finalConn = existing ? { ...existing, ...conn } : conn;
      await store.save(finalConn);
      imported++;
    }
    treeProvider.refresh();
    vscode.window.showInformationMessage(l10n('conn.importDone', { count: imported }));
  });
}
