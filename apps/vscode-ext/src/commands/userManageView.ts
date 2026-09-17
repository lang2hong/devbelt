import * as vscode from 'vscode';
import { BaseWebView } from '../result/baseWebView';
import { DbTreeNode } from '../tree/dbTreeNode';
import type { SavedConnection } from '../connection/connectionStore';
import type { Deps } from './shared';
import { recordBulkHistory, requireCapability } from './shared';
import { l10n } from '../i18n';
import { AuditLogger } from '../utils/auditLogger';
import { ensureWritable } from '../utils/sqlSafety';

/**
 * 可授予的权限白名单。
 *
 * 与 db-core `TableService` 里的校验正则对应；前端只提供选择，
 * 真正的合法性判断仍在 db-core 内（前端列表不是安全边界）。
 *
 * 顺序按「数据 → 结构 → 管理」分组，常用权限在前。
 */
const PRIVILEGES = [
  // 数据
  'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  // 结构
  'CREATE', 'CREATE VIEW', 'SHOW VIEW', 'ALTER', 'DROP', 'INDEX',
  'REFERENCES', 'TRIGGER', 'EXECUTE',
  // 管理
  'ALL PRIVILEGES', 'USAGE', 'SHOW DATABASES', 'PROCESS', 'RELOAD',
  'REPLICATION CLIENT', 'REPLICATION SLAVE', 'SHUTDOWN', 'SUPER',
];

/**
 * 用户管理面板。
 *
 * 用户是**实例级**对象：`getUsers()` 与库无关，此前把 user 分类挂在库节点下，
 * MySQL 有 20 个库就会看到 20 份一模一样的用户列表。现在从连接节点右键进入，
 * 所有操作（建/删/改密码/授权/撤权）集中在一个面板里完成，
 * 不再散落成 5 条右键命令 + 手打权限名的输入框。
 *
 * 按连接单例：同一连接重复打开时复用面板，避免两个面板各持一份过期列表。
 */
export class UserManageView extends BaseWebView {
  private static readonly views = new Map<string, UserManageView>();
  /** 首个 ready 只用于切换视图模式，详见 handleMessage。 */
  private initSent = false;

  private constructor(
    private readonly conn: SavedConnection,
    private readonly deps: Deps,
  ) {
    super('devbelt.userManage', `${l10n('user.manageTitle')} @ ${conn.name || conn.host}`);
  }

  static open(deps: Deps, node: DbTreeNode): void {
    const conn = node.conn;
    if (!conn) return;
    const existing = UserManageView.views.get(conn.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.loadUsers();
      return;
    }
    const view = new UserManageView(conn, deps);
    UserManageView.views.set(conn.id, view);
  }

  protected async handleMessage(msg: any): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  private async dispatch(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // webview 默认挂载 QueryView，它会先发一次 ready；切到本视图后新组件
        // 再发一次，那次才该送数据。否则数据发给了即将被卸载的组件。
        this.post({
          type: 'init',
          mode: 'userManage',
          connLabel: this.conn.name || this.conn.host,
          privileges: PRIVILEGES,
          supportsHost: this.conn.dbType === 'MYSQL',
        });
        if (this.initSent) await this.loadUsers();
        this.initSent = true;
        return;
      case 'refresh':
        await this.loadUsers();
        return;
      case 'selectUser':
        await this.loadGrants(msg);
        return;
      case 'createUser':
        await this.createUser(msg);
        return;
      case 'dropUser':
        await this.dropUser(msg);
        return;
      case 'changePassword':
        await this.changePassword(msg);
        return;
      case 'grant':
        await this.grant(msg);
        return;
      case 'revoke':
        await this.revoke(msg);
        return;
      default:
        return;
    }
  }

  private async loadUsers(): Promise<void> {
    try {
      const session = await this.deps.manager.connect(this.conn);
      const users = await session.metadata.getUsers();
      // PG 授权必须带 schema，MySQL 可以不带（*.*）。多库方言下列出全部库
      // 供选择，单库方言只有连接自带的那一个。
      const databases = session.capabilities.multiDatabaseExplorer
        ? await session.metadata.getDatabases()
        : [this.conn.database || ''].filter(Boolean);
      this.post({ type: 'users', users, databases });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  /**
   * 查询选中用户的已有权限并下发，用于前端默认勾选。
   *
   * 选中用户时前端发 selectUser；切库时带 database 重发以回显该库权限。
   * 查询被拒（低权账号查别人）降级返回空，不阻塞面板。
   */
  private async loadGrants(msg: any): Promise<void> {
    const { name, host } = splitUser(msg.user);
    const database = msg.database || undefined;
    try {
      const session = await this.deps.manager.connect(this.conn);
      const grants = await session.metadata.getUserGrants(name, host, database);
      this.post({ type: 'grants', grants });
    } catch {
      this.post({ type: 'grants', grants: [] });
    }
  }

  /**
   * 所有用户变更的唯一出口：只读拦截 → 能力校验 → 执行 → 审计 → 重载列表。
   *
   * 集中在一处，避免每个分支各写一遍守卫与审计（漏一处就少一道保护或一条痕迹）。
   */
  private async mutate(
    action: string,
    fn: (session: Awaited<ReturnType<Deps['manager']['connect']>>) => Promise<void>,
  ): Promise<void> {
    if (!ensureWritable(this.conn)) return;
    const session = await this.deps.manager.connect(this.conn);
    if (!requireCapability(session, 'manageUsers')) return;
    await fn(session);
    AuditLogger.tryLog({
      action: 'user_manage',
      connName: this.conn.name || this.conn.host,
      sql: action,
    });
    await this.loadUsers();
  }

  private async createUser(msg: any): Promise<void> {
    const name = String(msg.name || '').trim();
    const password = String(msg.password || '');
    const host = String(msg.host || '%').trim() || '%';
    if (!name) throw new Error(l10n('user.nameRequired'));
    await this.mutate(`CREATE USER ${name}@${host}`, async (session) => {
      await session.table.createUser(name, password, host);
      // 真实语句含明文密码，带 skipHistory 不进历史；这里补一条脱敏摘要。
      // 历史会持久化并参与云同步，密码不能进去。
      await recordBulkHistory(this.deps, this.conn, l10n('history.createUser', { name: `${name}@${host}` }));
    });
    this.post({ type: 'done', message: l10n('user.created', { name }) });
  }

  private async dropUser(msg: any): Promise<void> {
    const { name, host } = splitUser(msg.user);
    await this.mutate(`DROP USER ${msg.user}`, async (session) => {
      await session.table.dropUser(name, host);
    });
    this.post({ type: 'done', message: l10n('user.dropped', { name: msg.user }) });
  }

  private async changePassword(msg: any): Promise<void> {
    const { name, host } = splitUser(msg.user);
    const password = String(msg.password || '');
    if (!password) throw new Error(l10n('user.passwordRequired'));
    await this.mutate(`ALTER USER ${msg.user} (password changed)`, async (session) => {
      await session.table.alterUserPassword(name, password, host);
      await recordBulkHistory(this.deps, this.conn, l10n('history.alterPassword', { name: msg.user }));
    });
    this.post({ type: 'done', message: l10n('user.passwordChanged', { name: msg.user }) });
  }

  private async grant(msg: any): Promise<void> {
    const { name, host } = splitUser(msg.user);
    const privileges: string[] = Array.isArray(msg.privileges) ? msg.privileges : [];
    if (!privileges.length) throw new Error(l10n('user.privRequired'));
    const database = msg.database || undefined;
    await this.mutate(`GRANT ${privileges.join(', ')} TO ${msg.user}`, async (session) => {
      for (const priv of privileges) {
        await session.table.grantPrivilege(name, priv, database, host);
      }
    });
    this.post({ type: 'done', message: l10n('user.granted', { priv: privileges.join(', '), name: msg.user }) });
  }

  private async revoke(msg: any): Promise<void> {
    const { name, host } = splitUser(msg.user);
    const privileges: string[] = Array.isArray(msg.privileges) ? msg.privileges : [];
    if (!privileges.length) throw new Error(l10n('user.privRequired'));
    const database = msg.database || undefined;
    await this.mutate(`REVOKE ${privileges.join(', ')} FROM ${msg.user}`, async (session) => {
      for (const priv of privileges) {
        await session.table.revokePrivilege(name, priv, database, host);
      }
    });
    this.post({ type: 'done', message: l10n('user.revoked', { priv: privileges.join(', '), name: msg.user }) });
  }

  protected onDispose(): void {
    super.onDispose();
    UserManageView.views.delete(this.conn.id);
  }
}

/** 拆分 `name@host` 展示名；PG 无 host 概念，缺省 `%`。 */
function splitUser(label: string): { name: string; host: string } {
  const text = String(label || '');
  const at = text.lastIndexOf('@');
  if (at <= 0) return { name: text, host: '%' };
  return { name: text.slice(0, at), host: text.slice(at + 1) || '%' };
}
