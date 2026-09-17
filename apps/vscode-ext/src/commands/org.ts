import * as vscode from 'vscode';
import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from '../connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager';
import { ORG_CONNECTION_ID_PREFIX } from '../sync/entitlementGate';
import type { QueryExecutor } from '../result/queryExecutor';
import { OrgWorkspace } from '../org/workspace';
import { OrgApiError } from '../org/client';
import { isConnectionTemplate, type ConnectionTemplateContent, type OrganizationRole, type QueryContent } from '../org/types';
import type { OrgLocalCredential } from '../org/credentialVault';
import { OrgTreeNode, OrgTreeDataProvider } from '../tree/orgTreeDataProvider';
import { l10n } from '../i18n';
import { DEFAULT_SERVER_URL } from '../sync/authService';

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
  /** 该资源所属组织的角色（驱动保存按钮可见性；服务端 403 仍是最终边界）。 */
  role: OrganizationRole;
};

/** 服务端模板白名单为 mysql；客户端在连接前再防御一次，非 mysql 不支持建连。 */
export function isSupportedTemplateType(c: ConnectionTemplateContent): boolean {
  return c.databaseType === 'mysql';
}

/** 组织 API 错误的 UI 分类（pure，便于单测）。 */
export type OrgErrorKind = 'auth' | 'forbidden' | 'conflict' | 'generic';

export function classifyOrgError(e: unknown): OrgErrorKind {
  if (e instanceof OrgApiError) {
    if (e.isAuthFailure()) return 'auth';
    if (e.isForbidden()) return 'forbidden';
    if (e.isVersionConflict()) return 'conflict';
  }
  return 'generic';
}

export function registerOrgCommands(deps: OrgDeps): void {
  const { context, workspace, manager, executor, tree } = deps;
  const bindings = new Map<string, OrgDocState>();

  const sub = (cmd: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));

  // 编辑器上下文同步：editor/title 的保存/运行命令据此决定是否可见（含绑定组织的角色）。
  const refreshEditorContext = (): void => {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const state = active ? bindings.get(active) : undefined;
    void vscode.commands.executeCommand('setContext', 'devbelt.orgResourceEditor', state?.kind === 'resource');
    void vscode.commands.executeCommand('setContext', 'devbelt.orgSessionEditor', state?.kind === 'session');
    void vscode.commands.executeCommand(
      'setContext',
      'devbelt.orgResourceEditorRole',
      state?.kind === 'resource' ? state.role : undefined,
    );
  };
  const bind = (uri: string, state: OrgDocState): void => {
    bindings.set(uri, state);
    refreshEditorContext();
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshEditorContext()),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (bindings.delete(document.uri.toString())) refreshEditorContext();
    }),
  );

  sub('devbelt.org.refresh', () => tree.refresh());

  // 组织视图空态「创建或加入组织」→ 打开 Web 控制台组织页（浏览器）。
  sub('devbelt.org.openConsole', () => {
    void vscode.env.openExternal(vscode.Uri.parse(`${DEFAULT_SERVER_URL}/db/organizations`));
  });

  // ── 连接模板（核心：模板 content + 本地凭据映射）──
  sub('devbelt.org.connectTemplate', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const resource = node?.resource;
    if (!orgId || !resource) return;
    if (resource.resourceType !== 'connection_template') return;

    const detail = await workspace.getResource(orgId, resource.resourceId).catch((e) => {
      showError(e);
      return undefined;
    });
    if (!detail || !isConnectionTemplate(detail.content)) {
      vscode.window.showErrorMessage(l10n('org.notTemplate'));
      return;
    }
    const c = detail.content as ConnectionTemplateContent;

    // 非 mysql 模板：不读取/写入 vault、不建连。
    if (!isSupportedTemplateType(c)) {
      vscode.window.showWarningMessage(l10n('org.templateTypeUnsupported'));
      return;
    }

    await workspace.waitForCleanup();
    let cred = (await workspace.vault.get(orgId, resource.resourceId)) ?? {};
    if (!c.username && !cred.username) {
      const u = await vscode.window.showInputBox({ prompt: l10n('org.usernamePrompt', { name: resource.name }) });
      if (u === undefined) return;
      cred = { ...cred, username: u };
    }
    if (!cred.password) {
      const p = await vscode.window.showInputBox({ prompt: l10n('org.passwordPrompt', { name: resource.name }), password: true });
      if (p === undefined) return;
      cred = { ...cred, password: p };
    }

    // verify-ca/verify-full：选择本机 CA 文件（仅本次临时会话，不随 vault 持久化）；取消则不建连。
    if (c.ssl?.mode === 'verify-ca' || c.ssl?.mode === 'verify-full') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: l10n('org.selectCa'),
      });
      if (!picked?.length) return;
      cred = { ...cred, caPath: picked[0].fsPath };
    }

    // 持久化凭据时剥离本机 CA 路径（路径非秘密，但也不应保留/上传）。
    const persisted: OrgLocalCredential = { ...cred };
    delete persisted.caPath;
    await workspace.vault.set(orgId, resource.resourceId, persisted);

    const conn = toSavedConnection(orgId, resource.resourceId, resource.name, c, cred);
    try {
      await manager.connect(conn, { scope: 'organization' });
    } catch (e) {
      // 建连失败：剔除可能已持久化的错误密码，避免下一次连接时无限重试死循环。
      await workspace.vault.delete(orgId, resource.resourceId).catch(() => {});
      showError(e);
      return;
    }

    const doc = await vscode.workspace.openTextDocument({ content: '', language: 'sql' });
    const editor = await vscode.window.showTextDocument(doc);
    bind(editor.document.uri.toString(), { kind: 'session', conn, db: c.database });
    vscode.window.showInformationMessage(l10n('org.connected', { name: resource.name, host: c.host, port: String(c.port) }));
  });

  // ── 运行组织连接模板会话上的 SQL ──
  sub('devbelt.org.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const state = bindings.get(editor.document.uri.toString());
    if (!state || state.kind !== 'session') {
      vscode.window.showInformationMessage(l10n('org.notSession'));
      return;
    }
    const sql = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    await executor.run(state.conn, sql, state.db, 'reuse');
  });

  // ── 打开资源（query → SQL 编辑器；template → JSON 只读）──
  sub('devbelt.org.openResource', async (node: OrgTreeNode) => {
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
      bind(editor.document.uri.toString(), {
        kind: 'resource',
        mode: 'update',
        orgId,
        folderId: detail.folderId,
        resourceId: detail.resourceId,
        baseVersion: detail.version,
        name: detail.name,
        role: node.role ?? 'member',
      });
    } else {
      const json = JSON.stringify(detail.content, null, 2);
      const doc = await vscode.workspace.openTextDocument({ content: json, language: 'json' });
      await vscode.window.showTextDocument(doc);
    }
  });

  // ── 新建 query 资源 ──
  sub('devbelt.org.newQuery', async (node: OrgTreeNode) => {
    const pickedOrg = node?.orgId ? undefined : await pickOrgId(workspace);
    const orgId = node?.orgId ?? pickedOrg?.orgId;
    if (!orgId) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('org.queryNamePrompt') });
    if (!name) return;
    // 带节点 → 用节点目录；命令面板入口（无节点）→ 选目录（含根目录）。
    let folderId: string | null = node?.folderId ?? null;
    if (!node) {
      const picked = await pickFolderId(workspace, orgId);
      if (picked === undefined) return;
      folderId = picked;
    }
    const role: OrganizationRole = node?.role ?? pickedOrg?.role ?? 'member';
    const doc = await vscode.workspace.openTextDocument({ content: '', language: 'sql' });
    const editor = await vscode.window.showTextDocument(doc);
    bind(editor.document.uri.toString(), {
      kind: 'resource',
      mode: 'create',
      orgId,
      folderId,
      name,
      role,
    });
  });

  // ── 保存资源（create/update；409 冲突弹三选）──
  sub('devbelt.org.saveResource', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const state = bindings.get(editor.document.uri.toString());
    if (!state || state.kind !== 'resource') {
      vscode.window.showInformationMessage(l10n('org.notResource'));
      return;
    }
    const sql = editor.document.getText();
    const content: QueryContent = { sql };
    try {
      if (state.mode === 'create') {
        await workspace.createResource(state.orgId, { resourceType: 'query', name: state.name, folderId: state.folderId, content });
        vscode.window.showInformationMessage(l10n('org.created', { name: state.name }));
      } else if (state.resourceId !== undefined) {
        const updated = await workspace.updateResource(state.orgId, state.resourceId, { baseVersion: state.baseVersion ?? 1, content });
        bind(editor.document.uri.toString(), { ...state, baseVersion: updated.version });
        vscode.window.showInformationMessage(l10n('org.saved', { name: state.name }));
      }
      tree.refresh();
    } catch (e) {
      if (e instanceof OrgApiError && e.isVersionConflict() && state.resourceId !== undefined) {
        const choice = await vscode.window.showWarningMessage(
          l10n('org.conflict.message', { version: String(e.currentVersion ?? '?') }),
          { modal: true },
          l10n('org.conflict.overwrite'),
          l10n('org.conflict.refresh'),
          l10n('common.cancel'),
        );
        if (choice === l10n('org.conflict.overwrite')) {
          try {
            // 以 currentVersion 作为新 baseVersion 重发本地 SQL（覆盖远端更新）。
            const updated = await workspace.updateResource(state.orgId, state.resourceId, {
              baseVersion: e.currentVersion ?? state.baseVersion ?? 1,
              content,
            });
            bind(editor.document.uri.toString(), { ...state, baseVersion: updated.version });
            vscode.window.showInformationMessage(l10n('org.saved', { name: state.name }));
          } catch (err) {
            showError(err);
          }
        } else if (choice === l10n('org.conflict.refresh')) {
          try {
            // 强制拉取远端，替换编辑器文本与 binding 的 baseVersion（丢弃本地编辑）。
            const detail = await workspace.getResource(state.orgId, state.resourceId, true);
            const refreshedSql = (detail.content as QueryContent).sql ?? '';
            await editor.edit((eb) => {
              const end = editor.document.positionAt(editor.document.getText().length);
              eb.replace(new vscode.Range(0, 0, end.line, end.character), refreshedSql);
            });
            bind(editor.document.uri.toString(), { ...state, baseVersion: detail.version });
          } catch (err) {
            showError(err);
          }
        }
        // cancel → 保留本地编辑与原 binding，不请求更新。
        tree.refresh();
        return;
      }
      showError(e);
    }
  });

  // ── 删除资源 ──
  sub('devbelt.org.deleteResource', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const resource = node?.resource;
    if (!orgId || !resource) return;
    const ok = await vscode.window.showWarningMessage(l10n('org.deleteResourceConfirm', { name: resource.name }), { modal: true }, l10n('common.delete'));
    if (ok !== l10n('common.delete')) return;
    await workspace.deleteResource(orgId, resource.resourceId).catch(showError);
    tree.refresh();
  });

  // ── 新建目录 ──
  sub('devbelt.org.newFolder', async (node: OrgTreeNode) => {
    const orgId = node?.orgId ?? (await pickOrgId(workspace))?.orgId;
    if (!orgId) return;
    const name = await vscode.window.showInputBox({ prompt: l10n('org.folderNamePrompt') });
    if (!name) return;
    await workspace.createFolder(orgId, name, node?.folderId ?? null).catch(showError);
    tree.refresh();
  });

  // ── 删除目录 ──
  sub('devbelt.org.deleteFolder', async (node: OrgTreeNode) => {
    const orgId = node?.orgId;
    const folderId = node?.folderId;
    if (!orgId || !folderId) return;
    const ok = await vscode.window.showWarningMessage(l10n('org.deleteFolderConfirm', { name: node.label }), { modal: true }, l10n('common.delete'));
    if (ok !== l10n('common.delete')) return;
    await workspace.deleteFolder(orgId, folderId).catch(showError);
    tree.refresh();
  });
}

/**
 * 模板 content + 本地凭据 → 临时 SavedConnection（仅内存）。
 *
 * SSL：require → useSSL=true/rejectUnauthorized=false；verify-ca/verify-full →
 * useSSL=true/rejectUnauthorized=true（配合 cred.caPath）；disable → 不启用 SSL。
 */
/** 组织连接模板的 databaseType → 引擎；未知值 fail-closed（不静默当 MySQL）。 */
function databaseTypeOf(raw: string): DatabaseType {
  switch (raw.toLowerCase()) {
    case 'mysql': return DatabaseType.MYSQL;
    case 'postgresql':
    case 'postgres':
    case 'pg': return DatabaseType.PG;
    case 'sqlite': return DatabaseType.SQLITE;
    default: throw new Error(`Unsupported databaseType in connection template: ${raw}`);
  }
}

export function toSavedConnection(
  orgId: string,
  resourceId: string,
  name: string,
  c: ConnectionTemplateContent,
  cred: OrgLocalCredential,
): SavedConnection {
  const mode = c.ssl?.mode;
  const useSSL = mode === 'require' || mode === 'verify-ca' || mode === 'verify-full';
  const rejectUnauthorized = c.ssl?.rejectUnauthorized ?? (mode === 'verify-ca' || mode === 'verify-full'
    ? true
    : mode === 'require'
      ? false
      : undefined);
  return {
    id: `${ORG_CONNECTION_ID_PREFIX}${orgId}:${resourceId}`,
    name,
    dbType: databaseTypeOf(c.databaseType),
    host: c.host,
    port: c.port,
    user: cred.username ?? c.username ?? '',
    password: cred.password,
    database: c.database,
    useSSL,
    rejectUnauthorized,
    caPath: cred.caPath,
    sshHost: cred.sshHost,
    sshPort: cred.sshPort,
    sshUser: cred.sshUser,
    sshPassword: cred.sshPassword,
    sshPrivateKeyPath: cred.sshPrivateKeyPath,
    sshPassphrase: cred.sshPassphrase,
  };
}

function showError(e: unknown): void {
  switch (classifyOrgError(e)) {
    case 'auth':
      // 401 统一由 OrgWorkspace.onAuthFailure → extension 弹「登录已过期」，此处不重复。
      return;
    case 'forbidden':
      vscode.window.showErrorMessage(l10n('org.error.forbidden'));
      return;
    default:
      vscode.window.showErrorMessage(l10n('org.error.generic'));
  }
}

/** 标题栏入口无节点时选组织：单组织直接用，多组织弹选择，无组织提示登录。 */
async function pickOrgId(workspace: OrgWorkspace): Promise<{ orgId: string; role: OrganizationRole } | undefined> {
  const orgs = await workspace.listOrganizations().catch(() => []);
  if (!orgs.length) {
    vscode.window.showInformationMessage(l10n('org.noOrganizations'));
    return undefined;
  }
  if (orgs.length === 1) return { orgId: orgs[0].organizationId, role: orgs[0].role };
  const picked = await vscode.window.showQuickPick(
    orgs.map((o) => ({ label: o.name, organizationId: o.organizationId, role: o.role })),
    { placeHolder: l10n('org.selectOrganization') },
  );
  return picked ? { orgId: picked.organizationId, role: picked.role } : undefined;
}

/** 命令面板入口选目录：含「根目录」选项；取消返回 undefined。 */
async function pickFolderId(workspace: OrgWorkspace, orgId: string): Promise<string | null | undefined> {
  const folders = await workspace.listFolders(orgId).catch(() => []);
  const items = [
    { label: l10n('org.folderRoot'), folderId: null as string | null },
    ...folders.map((f) => ({ label: f.name, folderId: f.folderId })),
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('org.selectFolder') });
  if (!picked) return undefined;
  return picked.folderId;
}
