import { DbTreeNode } from '../tree/dbTreeNode';
import type { Deps, Sub } from './shared';
import { UserManageView } from './userManageView';

/**
 * 用户管理入口（数据库实例用户：建/删/改密码/授权/撤权）。
 *
 * 原先是 5 条右键命令散落在库级 user 分类下，撤权还得手打权限名。现在统一收敛为
 * 连接右键打开一个 webview 面板 —— 用户是实例级对象，挂在库下会让 MySQL 的每个库
 * 都重复显示同一份列表。应用账号（登录/账户/设备/登出）见 `account.ts`。
 */
export function registerUserCommands(deps: Deps, sub: Sub): void {
  sub('dbclient.manageUsers', async (node: DbTreeNode) => {
    if (!node?.conn) return;
    UserManageView.open(deps, node);
  });
}
