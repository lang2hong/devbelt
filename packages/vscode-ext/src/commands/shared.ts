import * as vscode from 'vscode';
import { ConnectionStore } from '../connection/connectionStore';
import type { SavedConnection } from '../connection/connectionStore';
import { ConnectionManager } from '../connection/connectionManager';
import { ConnectionContext } from '../connection/connectionContext';
import { DbTreeDataProvider } from '../tree/dbTreeDataProvider';
import { QueryExecutor } from '../result/queryExecutor';
import { HistoryStore } from '../history/historyStore';
import { AuthService } from '../sync/authService';
import { SyncManager } from '../sync/syncManager';
import { l10n } from '../i18n';
import type { DatabaseOperation } from '@db-client/core';
import type { ConnectionSession } from '../connection/connectionManager';

export interface Deps {
  context: vscode.ExtensionContext;
  store: ConnectionStore;
  manager: ConnectionManager;
  treeProvider: DbTreeDataProvider;
  executor: QueryExecutor;
  history: HistoryStore;
  auth: AuthService;
  sync: SyncManager;
  syncBar: SyncStatusBarLike;
  connCtx: ConnectionContext;
}

export interface SyncStatusBarLike {
  update(): void;
}

export type Sub = (cmd: string, handler: (...args: any[]) => any) => void;

export function makeSub(context: vscode.ExtensionContext): Sub {
  return (cmd, handler) => context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
}

export async function confirm(msgKey: string, btnKey: string, name: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(l10n(msgKey, { name }), { modal: true }, l10n(btnKey))) === l10n(btnKey);
}

/**
 * 为批量操作写一条汇总历史。
 *
 * 导入/恢复/库间传输/Mock 会执行成百上千条语句，逐条进历史会把上限 100 条的
 * 历史整段冲干（所以那些语句都带 `skipHistory`）。这里补一条人类可读的摘要，
 * 让「我什么时候往这张表导过数据」仍然查得到。
 *
 * 写入失败静默吞掉：历史是旁路设施，不能让它把一次已经成功的导入报成失败。
 */
export async function recordBulkHistory(
  deps: Deps,
  conn: SavedConnection,
  summary: string,
  database?: string,
  rowCount?: number,
  costTime = 0,
): Promise<void> {
  try {
    await deps.history.add({
      sql: summary,
      connection: conn.name || conn.host,
      connectionId: conn.id,
      database,
      costTime,
      rowCount,
    });
  } catch { /* best-effort history */ }
}

export function requireCapability(session: ConnectionSession, operation: DatabaseOperation): boolean {
  if (session.capabilities.operations.includes(operation)) return true;
  vscode.window.showWarningMessage(`${session.capabilities ? 'This database' : 'Connection'} does not support ${operation}.`);
  return false;
}

export async function openSqlDoc(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'sql' });
  await vscode.window.showTextDocument(doc);
}

export async function openSqlDocEditor(content: string): Promise<vscode.TextEditor | undefined> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'sql' });
  return vscode.window.showTextDocument(doc);
}

export async function openQueryFile(deps: Deps, conn: SavedConnection, database: string | undefined, queryId: string): Promise<void> {
  const q = deps.store.getQueries(conn.id, database).find((x) => x.id === queryId);
  if (!q) return;
  const dir = vscode.Uri.joinPath(deps.context.globalStorageUri, 'queries');
  await vscode.workspace.fs.createDirectory(dir);
  const file = vscode.Uri.joinPath(dir, `${queryId}.sql`);
  await vscode.workspace.fs.writeFile(file, Buffer.from(q.sql || '', 'utf8'));
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  deps.connCtx.setForDoc(editor.document.uri.toString(), conn, database);
  deps.connCtx.setSavedQueryForDoc(editor.document, queryId);
}

export async function pickConnection(store: ConnectionStore): Promise<SavedConnection | undefined> {
  const list = store.list();
  if (!list.length) {
    vscode.window.showInformationMessage(l10n('cmd.noConnection'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name || c.host, detail: c.host, value: c })),
    { placeHolder: l10n('cmd.selectConnection') },
  );
  return picked?.value;
}

export async function promptMasterPassword(): Promise<string | undefined> {
  return vscode.window.showInputBox({ prompt: l10n('cmd.masterPassword'), password: true });
}

/** 主密码 + 验证结果的回调。见 resolveMasterPassword。 */
export interface ResolvedMasterPassword {
  password: string;
  /** 密码确认可用（能解开远端数据）后调用，按设置决定是否写入 SecretStorage */
  confirm(): Promise<void>;
  /** 密码不可用时调用，清掉可能已记住的错误值 */
  reject(): Promise<void>;
}

/**
 * 取主密码：优先用已记住的，否则提示输入。
 *
 * **不再在这里写入 SecretStorage。** 原实现是"提示输入 → 立刻记住 → 返回"，
 * 而调用方拿到密码后才去 preview —— 那时才知道密码对不对。输错一次的后果：
 *
 *  - pull：错误密码被记住 → 本次解密失败 → 下次 pull 直接取那个错误密码，
 *    **不再提示输入**，再次失败。用户被永久卡住，除非知道"忘记主密码"藏在
 *    logout 里。
 *  - push：更糟。错误密码会被用来**加密并上传**，远端数据从此用一个用户自己
 *    都不知道的密码加密，其他设备用正确密码拉取会全部解密失败 ——
 *    数据丢失级别的后果，起因只是一次手抖。
 *
 * 改成由调用方在验证成功后 `confirm()`、失败时 `reject()`。
 * 已记住的密码不需要重复写入，所以它的 confirm 是空操作。
 */
export async function resolveMasterPassword(
  sync: SyncManager,
  remember: boolean,
): Promise<ResolvedMasterPassword | undefined> {
  const noop = async (): Promise<void> => {};
  const forget = () => sync.forgetMasterPassword();

  const remembered = await sync.getRememberedMasterPassword();
  if (remembered) {
    return { password: remembered, confirm: noop, reject: forget };
  }

  const mp = await promptMasterPassword();
  // 空字符串按取消处理：它不可能是有效主密码，当成"输入了"会拿它去解密/加密
  if (!mp) return undefined;

  return {
    password: mp,
    confirm: remember ? async () => { await sync.rememberMasterPassword(mp); } : noop,
    reject: forget,
  };
}

/**
 * 取主密码 → 用它做一次需要解密的操作 → 按结果 confirm / reject。
 *
 * 提取成函数而不是在两个命令里各写一遍，理由有两个：
 *  - pull 与 push 的这段编排完全相同，重复写一定会漂移（改了一处忘了另一处）。
 *  - `confirm()` / `reject()` 漏调是**静默失效**：漏 confirm 则"记住主密码"
 *    这个功能形同不存在（每次同步都要重输），漏 reject 则历史遗留的错误密码
 *    永远清不掉。两者都不会报错，只能靠测试钉住 —— 而分散在命令注册回调里
 *    的代码需要整套 vscode mock 才测得到。
 *
 * 返回 undefined 表示"用户取消"或"操作失败"，调用方直接返回即可；
 * 失败的错误信息由 onError 展示（各命令的文案不同）。
 */
export async function withMasterPassword<T>(
  sync: SyncManager,
  remember: boolean,
  operation: (password: string) => Promise<T>,
  onError: (err: unknown) => void,
): Promise<{ password: string; result: T } | undefined> {
  const mp = await resolveMasterPassword(sync, remember);
  if (!mp) return undefined;
  try {
    const result = await operation(mp.password);
    // 只有真的解开了远端数据才记住这个密码
    await mp.confirm();
    return { password: mp.password, result };
  } catch (err) {
    // 解不开就清掉可能已记住的错误值，让下次能重新输入；
    // 否则历史遗留的错误密码会让用户永远进不去。
    await mp.reject();
    onError(err);
    return undefined;
  }
}
