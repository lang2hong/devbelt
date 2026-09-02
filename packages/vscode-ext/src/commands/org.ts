import * as vscode from 'vscode';
import { DatabaseType } from '@db-client/core';
import type { SavedConnection } from '../connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager';
import { ORG_CONNECTION_ID_PREFIX } from '../sync/entitlementGate';
import type { QueryExecutor } from '../result/queryExecutor';
import { OrgWorkspace } from '../org/workspace';
import { OrgApiError } from '../org/client';
import { isConnectionTemplate, type ConnectionTemplateContent, type QueryContent } from '../org/types';
import type { OrgLocalCredential } from '../org/credentialVault';
import { OrgTreeNode, OrgTreeDataProvider } from '../tree/orgTreeDataProvider';

/**
 * 组织 Workspace 命令（实施规格 §6）。
 *
 * 连接模板：模板 content（服务器） + 本地凭据（CredentialVault）→ 临时 SavedConnection，
 * 只存在于内存，绝不写入个人 ConnectionStore、绝不进请求体。
 */

interface OrgDeps {
  context: vscode.ExtensionContext;
  workspace: OrgWorkspace;
  manager: ConnectionManager;
  executor: QueryExecutor;
  tree: OrgTreeDataProvider;
}

/** 组织侧的编辑器绑定（内存）：连接模板会话，或待保存资源的编辑状态。 */
type OrgDocState = {
  kind: 'session';
  conn: SavedConnection;
  db?: string;
} | {
  kind: 'resource';
  mode: 'create' | 'update';
  orgId: string;
  folderId?: string | null;
  resourceId?: string;
  baseVersion?: number;
  name: string;
};

export function registerOrgCommands(deps: OrgDeps): void {
  const { context, workspace, manager, executor, tree } = deps;
  const bindings = new Map<string, OrgDocState>();

  const sub = (cmd: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));

  sub('dbclient.org.refresh', () => tree.refresh());

  // ── 连接模板（核心：模板 content + 本地凭据映射）──
  sub('dbclient.org.connectTemplate', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const resource = node?.resource;
    if (!orgId || !resource) return;
    if (resource.resourceType !== 'connection_template') return;

    const detail = await workspace.getResource(orgId, resource.resourceId).catch((e) => {
      showError(e);
      return undefined;
    });
    if (!detail || !isConnectionTemplate(detail.content)) {
      vscode.window.showErrorMessage('Resource is not a connection template.');
      return;
    }
    const c = detail.content as ConnectionTemplateContent;

    let cred = await workspace.vault.get(orgId, resource.resourceId);
    if (!cred) cred = {};
    if (!c.username && !cred.username) {
      const u = await vscode.window.showInputBox({ prompt: `Username for "${resource.name}"` });
      if (u === undefined) return;
      cred = { ...cred, username: u };
    }
    if (!cred.password) {
      const p = await vscode.window.showInputBox({ prompt: `Password for "${resource.name}"`, password: true });
      if (p === undefined) return;
      cred = { ...cred, password: p };
    }
    await workspace.vault.set(orgId, resource.resourceId, cred);

    const conn = toSavedConnection(orgId, resource.resourceId, resource.name, c, cred);
    await manager.connect(conn, { scope: 'organization' });

    const doc = await vscode.workspace.openTextDocument({ content: '', language: 'sql' });
    const editor = await vscode.window.showTextDocument(doc);
    bindings.set(editor.document.uri.toString(), { kind: 'session', conn, db: c.database });
    vscode.window.showInformationMessage(`Connected to "${resource.name}" (${c.host}:${c.port}).`);
  });

  // ── 运行组织连接模板会话上的 SQL ──
  sub('dbclient.org.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const state = bindings.get(editor.document.uri.toString());
    if (!state || state.kind !== 'session') {
      vscode.window.showInformationMessage('Current editor is not an organization connection session.');
      return;
    }
    const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    await executor.run(state.conn, sql, state.db, 'reuse');
  });

  // ── 打开资源（query → SQL 编辑器；template → JSON 只读）──
  sub('dbclient.org.openResource', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const resource = node?.resource;
    if (!orgId || !resource) return;
    const detail = await workspace.getResource(orgId, resource.resourceId).catch((e) => {
      showError(e);
      return undefined;
    });
    if (!detail) return;

    if (detail.resourceType === 'query') {
      const sql = (detail.content as QueryContent).sql ?? '';
      const doc = await vscode.workspace.openTextDocument({ content: sql, language: 'sql' });
      const editor = await vscode.window.showTextDocument(doc);
      bindings.set(editor.document.uri.toString(), {
        kind: 'resource',
        mode: 'update',
        orgId,
        folderId: detail.folderId,
        resourceId: detail.resourceId,
        baseVersion: detail.version,
        name: detail.name,
      });
    } else {
      const json = JSON.stringify(detail.content, null, 2);
      const doc = await vscode.workspace.openTextDocument({ content: json, language: 'json' });
      await vscode.window.showTextDocument(doc);
    }
  });

  // ── 新建 query 资源 ──
  sub('dbclient.org.newQuery', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    if (!orgId) return;
    const name = await vscode.window.showInputBox({ prompt: 'Query name' });
    if (!name) return;
    const doc = await vscode.workspace.openTextDocument({ content: '', language: 'sql' });
    const editor = await vscode.window.showTextDocument(doc);
    bindings.set(editor.document.uri.toString(), {
      kind: 'resource',
      mode: 'create',
      orgId,
      folderId: node?.folderId,
      name,
    });
  });

  // ── 保存资源（create/update；409 冲突保留本地编辑）──
  sub('dbclient.org.saveResource', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const state = bindings.get(editor.document.uri.toString());
    if (!state || state.kind !== 'resource') {
      vscode.window.showInformationMessage('Current editor is not an organization resource.');
      return;
    }
    const sql = editor.document.getText();
    const content: QueryContent = { sql };
    try {
      if (state.mode === 'create') {
        await workspace.createResource(state.orgId, { resourceType: 'query', name: state.name, folderId: state.folderId, content });
        vscode.window.showInformationMessage(`Resource "${state.name}" created.`);
      } else if (state.resourceId !== undefined) {
        const updated = await workspace.updateResource(state.orgId, state.resourceId, { baseVersion: state.baseVersion ?? 1, content });
        bindings.set(editor.document.uri.toString(), { ...state, baseVersion: updated.version });
        vscode.window.showInformationMessage(`Resource "${state.name}" saved.`);
      }
      tree.refresh();
    } catch (e) {
      if (e instanceof OrgApiError && e.isVersionConflict()) {
        // 409：保留本地编辑（编辑器不动），提示 currentVersion 供用户决定。
        vscode.window.showWarningMessage(
          `Resource was modified elsewhere (current version ${e.currentVersion ?? '?'}). Your local edit is preserved; refresh and re-apply.`,
        );
        return;
      }
      showError(e);
    }
  });

  // ── 删除资源 ──
  sub('dbclient.org.deleteResource', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const resource = node?.resource;
    if (!orgId || !resource) return;
    const ok = await vscode.window.showWarningMessage(`Delete resource "${resource.name}"?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await workspace.deleteResource(orgId, resource.resourceId).catch(showError);
    tree.refresh();
  });

  // ── 新建目录 ──
  sub('dbclient.org.newFolder', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    if (!orgId) return;
    const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
    if (!name) return;
    await workspace.createFolder(orgId, name, node?.folderId ?? null).catch(showError);
    tree.refresh();
  });

  // ── 删除目录 ──
  sub('dbclient.org.deleteFolder', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const folderId = node?.folderId;
    if (!orgId || !folderId) return;
    const ok = await vscode.window.showWarningMessage(`Delete folder "${node.label}"?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await workspace.deleteFolder(orgId, folderId).catch(showError);
    tree.refresh();
  });
}

function toSavedConnection(
  orgId: string,
  resourceId: string,
  name: string,
  c: ConnectionTemplateContent,
  cred: OrgLocalCredential,
): SavedConnection {
  const useSSL = c.ssl?.mode === 'require' || c.ssl?.mode === 'verify-ca' || c.ssl?.mode === 'verify-full';
  return {
    id: `${ORG_CONNECTION_ID_PREFIX}${orgId}:${resourceId}`,
    name,
    dbType: DatabaseType.MYSQL,
    host: c.host,
    port: c.port,
    user: cred.username ?? c.username ?? '',
    password: cred.password,
    database: c.database,
    useSSL,
    sshHost: cred.sshHost,
    sshPort: cred.sshPort,
    sshUser: cred.sshUser,
    sshPassword: cred.sshPassword,
    sshPrivateKeyPath: cred.sshPrivateKeyPath,
    sshPassphrase: cred.sshPassphrase,
  };
}

function showError(e: unknown): void {
  if (e instanceof OrgApiError) {
    vscode.window.showErrorMessage(`${e.message} (${e.code})`);
  } else if (e instanceof Error) {
    vscode.window.showErrorMessage(e.message);
  }
}