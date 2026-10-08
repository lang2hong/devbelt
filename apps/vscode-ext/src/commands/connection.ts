import * as vscode from 'vscode';
import { DatabaseType } from '@devbelt/db-core';
import { DbTreeNode, NodeKind } from '../tree/dbTreeNode';
import { ConnectionForm } from '../connection/connectionForm';
import { ConnectionPathError } from '../connection/connectionManager';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { l10n } from '../i18n';
import { AuditLogger } from '../utils/auditLogger';
import { flattenGroups } from '../utils/groupTree';
import { sanitizeConnectionForExport } from '../utils/connectionExport';
import { diagInfo, diagWarn } from '../utils/diagnostics';
import { chmod, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RedisConnectionSession } from '../connection/connectionSession';
import type { Deps, Sub } from './shared';
import { confirm } from './shared';
import {
  canImportConnections,
  canExportConnections,
  maxSavedConnections,
  maxConcurrentConnections,
} from '@devbelt/db-host/sync/entitlementGate';

async function redisServerVersion(session: RedisConnectionSession): Promise<string> {
  try {
    const info = await session.client.info('server');
    const m = /^redis_version:([^\r\n]+)/m.exec(info);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

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
  const { store, manager, treeProvider, connCtx, auth } = deps;

  // 连接资产门禁（§6.2）：本机保存连接数按个人档上限。
  const activeConnectionCount = () => store.list().length;
  const connectionCap = () => maxSavedConnections(auth.getCachedEntitlement());
  const atConnectionCap = () => {
    const cap = connectionCap();
    return cap > 0 && activeConnectionCount() >= cap;
  };

  sub('devbelt.addConnection', (node?: DbTreeNode) => {
    if (atConnectionCap()) {
      void vscode.window.showWarningMessage(l10n('conn.capReached', { count: connectionCap() }));
      return;
    }
    const gid = node?.kind === NodeKind.Group ? node.groupId : undefined;
    ConnectionForm.open(store, () => treeProvider.refresh(), gid, undefined, (c) => manager.effectiveConnection(c));
  });

  sub('devbelt.editConnection', (node: DbTreeNode) => {
    if (!node?.conn) return;
    const id = node.conn.id;
    // 编辑后连接配置可能变化（含 SSH 目标/认证）。已打开的会话与共享 SSH 隧道是按旧配置
    // 建立的：主会话重连会 closeTunnel，导致同连接的派生库/schema 会话静默持有失效隧道（H6）。
    // 统一在保存后关闭该连接的全部会话，下次使用按新配置重建。
    ConnectionForm.open(store, () => {
      // 无条件关闭：disposeConn/markClosed 对未打开连接是安全 no-op；仅判 peek(id) 会漏掉
      // 「主会话已被淘汰、仅剩派生库/schema 会话」的情况，那正是持有失效隧道的情形（H6）。
      const open = manager.peek(id);
      const hadTx = open?.kind === 'sql' && open.query.inTransaction;
      manager.disposeConn(id);
      treeProvider.markClosed(id);
      treeProvider.refresh();
      // 关闭会回滚未提交事务：明确告知，避免用户以为改动不影响正在进行的编辑。
      if (hadTx) vscode.window.showWarningMessage(l10n('conn.editClosedTx'));
    }, undefined, node.conn, (c) => manager.effectiveConnection(c));
  });

  sub('devbelt.cloneConnection', (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (atConnectionCap()) {
      void vscode.window.showWarningMessage(l10n('conn.capReached', { count: connectionCap() }));
      return;
    }
    const src = node.conn;
    const cloned: SavedConnection = { ...src, id: '', name: `${src.name || src.host} (copy)` };
    ConnectionForm.open(store, () => treeProvider.refresh(), undefined, cloned, (c) => manager.effectiveConnection(c));
  });

  sub('devbelt.searchConnections', async () => {
    const list = store.list();
    if (!list.length) {
      vscode.window.showInformationMessage(l10n('cmd.noConnection'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      list.map((c) => ({ label: c.name || c.host, description: `${c.dbType} · ${c.host}:${c.port}`, conn: c })),
      { placeHolder: l10n('search.connectionsPlaceholder'), matchOnDescription: true },
    );
    if (!picked) return;
    void vscode.commands.executeCommand('devbelt.openConnection', picked.conn).then(undefined, () => {});
  });

  sub('devbelt.deleteConnection', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    if (!(await confirm('conn.deleteConfirm', 'table.delete', node.conn.name || node.conn.host))) return;
    await store.remove(node.conn.id);
    diagInfo('connection remove', { id: node.conn.id });
    manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('devbelt.openConnection', async (conn: SavedConnection) => {
    if (!conn?.id) return;
    // 并发连接数门禁：已打开则不算新增；0 = 不限。
    const maxConcurrent = maxConcurrentConnections(auth.getCachedEntitlement());
    // 「是否已打开」与引擎无关：用 peek()（peekSql 只认 SQL 会话，会在 S2 误判已开的 Redis 连接）。
    if (maxConcurrent > 0 && !manager.peek(conn.id) && manager.openCount() >= maxConcurrent) {
      vscode.window.showWarningMessage(l10n('entitlement.maxConnections', { max: maxConcurrent }));
      return;
    }
    treeProvider.markOpen(conn.id);
    connCtx.setLast(conn);
    treeProvider.refresh();
    try {
      const session = await manager.connect(conn);
      manager.markExplicit(conn.id);
      const ver = session.kind === 'redis'
        ? await redisServerVersion(session)
        : await queryServerVersion(session, conn.dbType);
      treeProvider.setConnVersion(conn.id, `${conn.dbType} ${ver}`.trim());
      treeProvider.refresh();
      AuditLogger.tryLog({ action: 'connection_open', connName: conn.name || conn.host, database: conn.database });
    } catch (err) {
      if (err instanceof ConnectionPathError) {
        const fields = err.result.issues.map((i) => i.field).join(', ');
        const picked = await vscode.window.showErrorMessage(
          l10n('sync.pathInvalid', { fields }),
          l10n('sync.fixPathsAction'),
        );
        if (picked === l10n('sync.fixPathsAction')) {
          await vscode.commands.executeCommand('devbelt.fixConnectionPaths', conn);
        }
      } else {
        vscode.window.showErrorMessage(l10n('conn.openFailed', { message: (err as Error).message }));
      }
    }
  });

  sub('devbelt.closeConnection', (node: DbTreeNode) => {
    if (!node?.conn) return;
    manager.disposeConn(node.conn.id);
    treeProvider.markClosed(node.conn.id);
    treeProvider.refresh();
    AuditLogger.tryLog({ action: 'connection_close', connName: node.conn.name || node.conn.host });
    vscode.window.showInformationMessage(l10n('conn.closed', { name: node.conn.name || node.conn.host }));
  });

  sub('devbelt.refreshConnection', (node: DbTreeNode) => {
    if (node?.conn) manager.disposeConn(node.conn.id);
    treeProvider.refresh();
  });

  sub('devbelt.refresh', () => treeProvider.refresh());

  sub('devbelt.exportConnections', async (node?: DbTreeNode) => {
    if (!canExportConnections(auth.getCachedEntitlement())) {
      vscode.window.showWarningMessage(l10n('entitlement.exportRequired'));
      return;
    }
    const all = store.list();
    if (!all.length) {
      vscode.window.showInformationMessage(l10n('conn.exportNone'));
      return;
    }
    const picked = await (async () => {
      const grouped = new Map<string | undefined, SavedConnection[]>();
      for (const c of all) {
        const arr = grouped.get(c.groupId) ?? [];
        arr.push(c);
        grouped.set(c.groupId, arr);
      }
      type ExportPick = vscode.QuickPickItem & { value?: string };
      const items: ExportPick[] = [];
      const pushConn = (c: SavedConnection, depth: number) => {
        items.push({
          label: '\u00a0\u00a0'.repeat(depth) + (c.name || c.host),
          value: c.id,
          picked: !node || node.conn?.id === c.id,
        });
      };
      for (const c of grouped.get(undefined) ?? []) pushConn(c, 0);
      for (const { group, path } of flattenGroups(store.getGroups())) {
        items.push({ label: path, kind: vscode.QuickPickItemKind.Separator });
        for (const c of grouped.get(group.id) ?? []) pushConn(c, 1);
      }
      return vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: l10n('conn.exportPick') });
    })();
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
      defaultUri: vscode.Uri.file('devbelt-db-connections.json'),
      filters: { JSON: ['json'] },
    });
    if (!uri) return;
    const selected = all.filter((c) => picked.some((p) => p.value === c.id));
    let urlCredsStripped = false;
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      includeSecrets: includeSecrets.value,
      groups: store.getGroups(),
      connections: selected.map((c) => {
        if (includeSecrets.value) return { ...c };
        const { out, urlStripped } = sanitizeConnectionForExport(c);
        if (urlStripped) urlCredsStripped = true;
        return out;
      }),
    };
    // 含密码时为明文敏感文件：以 0600 写入；非 file scheme 回退到 workspace.fs。
    const json = JSON.stringify(payload, null, 2);
    if (uri.scheme === 'file') {
      // mode 只在新建文件时生效：覆盖已存在的宽松权限文件时需显式 chmod，
      // 否则明文凭据可能仍是 0644，同机其他用户可读。
      await writeFile(uri.fsPath, json, { encoding: 'utf8', mode: 0o600 });
      await chmod(uri.fsPath, 0o600).catch((e) => diagWarn('chmod connection export failed', String(e)));
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
    }
    if (urlCredsStripped) {
      void vscode.window.showWarningMessage(l10n('conn.exportUrlSecretsStripped'));
    }
    vscode.window.showInformationMessage(l10n('conn.exportDone', { count: selected.length }));
  });

  sub('devbelt.importConnections', async () => {
    if (!canImportConnections(auth.getCachedEntitlement())) {
      void vscode.window.showWarningMessage(l10n('conn.importUpgrade'));
      return;
    }
    const uri = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      openLabel: l10n('conn.importOpen'),
    });
    if (!uri?.[0]) return;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri[0])).toString('utf8');
    let payload: { version?: number; includeSecrets?: boolean; groups?: { id: string; name: string; parentId?: string }[]; connections?: SavedConnection[] };
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
    // 重建分组（保留原 id 与父级，维持连接归属）；旧文件无 groups 字段则跳过。
    // 同 id 分组为墓碑时会被复活（否则连接会因分组不可见而“导入成功却不显示”）。
    let groupsRevived = 0;
    if (Array.isArray(payload.groups)) {
      for (const g of payload.groups) {
        if (g?.id && typeof g.name === 'string') {
          if (await store.addGroupRaw(g.id, g.name, g.parentId) === 'revived') groupsRevived++;
        }
      }
    }
    // 导入同样受「本机保存连接数」门禁：add/clone 都校验，导入不校验即可无限落库。
    const cap = connectionCap();
    const usedIds = new Set(store.list().map((c) => c.id));
    let created = 0;
    let updated = 0;
    let skippedCap = 0;
    let invalid = 0;
    for (const conn of payload.connections) {
      if (!conn?.name && !conn?.host) { invalid++; continue; }
      const existing = conn.id ? store.get(conn.id) : undefined;
      if (existing) {
        await store.save({ ...existing, ...conn });
        updated++;
        continue;
      }
      if (cap > 0 && activeConnectionCount() >= cap) { skippedCap++; continue; }
      // id 缺失/重复：空 id 或与已有（或本文件前面）连接撞 id 时，两条连接会共用同一个
      // SecretStorage 键，密码互相覆盖。这里为新增项分配新 id；已有 id 且不冲突则保留。
      const id = conn.id && !usedIds.has(conn.id) ? conn.id : randomUUID();
      usedIds.add(id);
      await store.save({ ...conn, id });
      created++;
    }
    treeProvider.refresh();
    if (skippedCap > 0) {
      void vscode.window.showWarningMessage(l10n('conn.capReached', { count: cap }));
    }
    // 分项报告，避免「导入成功却不显示」这类问题无从判断。
    vscode.window.showInformationMessage(l10n('conn.importDone', { count: created, updated, skipped: skippedCap, invalid, revived: groupsRevived }));
  });
}
