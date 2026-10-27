import { l10n } from '../i18n';

/**
 * 树视图「⋯」（More Actions）菜单的纯构建逻辑（零 vscode 依赖，便于单测）。
 *
 * 三段：连接内容 / 同步 / 账户。
 * - 同步段按解锁态取动作：未解锁 → 「解锁 / 初始化」智能入口（远端有→解锁、无→初始化）；
 *   已解锁 → 「立即同步」（再列拉取/推送/自动同步开关）。
 * - 账户段只留「账户」入口（面板已含设备/套餐/管理后台/登出/改密，菜单不重复）。
 */

/** ⋯菜单的一项（`separator` 为不可选分隔线）。 */
export interface ExplorerMenuItem {
  label: string;
  value?: string;
  separator?: boolean;
}

export interface ExplorerMenuInput {
  loggedIn: boolean;
  unlocked: boolean;
  autoOn: boolean;
}

/** 菜单 value → 命令 id。 */
export const EXPLORER_MENU_COMMANDS: Record<string, string> = {
  addGroup: 'devbelt.addGroup',
  refresh: 'devbelt.refresh',
  searchConnections: 'devbelt.searchConnections',
  showHistory: 'devbelt.showHistory',
  showSlowQueries: 'devbelt.slowQueries',
  showAuditLog: 'devbelt.showAuditLog',
  showPoolStatus: 'devbelt.showPoolStatus',
  monitorTasks: 'devbelt.monitor.tasks',
  authenticator: 'devbelt.authenticator',
  importConnections: 'devbelt.importConnections',
  exportConnections: 'devbelt.exportConnections',
  login: 'devbelt.login',
  account: 'devbelt.account',
  syncEntry: 'devbelt.syncEntry',
  syncNow: 'devbelt.syncNow',
  syncPull: 'devbelt.syncPull',
  syncPush: 'devbelt.syncPush',
  toggleAutoSync: 'devbelt.toggleAutoSync',
};

export function buildExplorerMenu(input: ExplorerMenuInput): ExplorerMenuItem[] {
  const items: ExplorerMenuItem[] = [
    { label: l10n('explorer.section.connection'), separator: true },
    { label: l10n('cmd.groups'), value: 'addGroup' },
    { label: l10n('explorer.refresh'), value: 'refresh' },
    { label: l10n('explorer.searchConnections'), value: 'searchConnections' },
    { label: l10n('cmd.showHistory'), value: 'showHistory' },
    { label: l10n('explorer.tool.slowQueries'), value: 'showSlowQueries' },
    { label: l10n('explorer.tool.auditLog'), value: 'showAuditLog' },
    { label: l10n('explorer.tool.poolStatus'), value: 'showPoolStatus' },
    { label: l10n('explorer.tool.monitorTasks'), value: 'monitorTasks' },
    { label: l10n('explorer.tool.authenticator'), value: 'authenticator' },
    { label: l10n('account.action.importConnections'), value: 'importConnections' },
    { label: l10n('account.action.exportConnections'), value: 'exportConnections' },
  ];
  if (input.loggedIn) {
    items.push(
      { label: l10n('explorer.section.sync'), separator: true },
      input.unlocked
        ? { label: l10n('account.action.syncNow'), value: 'syncNow' }
        : { label: l10n('account.action.unlockOrInitialize'), value: 'syncEntry' },
    );
    if (input.unlocked) {
      items.push(
        { label: l10n('account.action.pull'), value: 'syncPull' },
        { label: l10n('account.action.push'), value: 'syncPush' },
        { label: input.autoOn ? l10n('sync.autoDisable') : l10n('sync.autoEnable'), value: 'toggleAutoSync' },
      );
    }
    items.push(
      { label: l10n('explorer.section.account'), separator: true },
      { label: l10n('account.title'), value: 'account' },
    );
  } else {
    items.push(
      { label: l10n('explorer.section.account'), separator: true },
      { label: l10n('cmd.login'), value: 'login' },
    );
  }
  return items;
}