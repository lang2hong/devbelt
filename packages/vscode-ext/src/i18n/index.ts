import * as vscode from 'vscode';

/**
 * 轻量国际化模块。
 *
 * 语言解析优先级（从高到低）：
 *  1. 用户显式设置 dbclient.language = zh / en（覆盖）
 *  2. VSCode 界面语言（默认，auto）
 *  3. 兜底英文
 *
 * 用法：
 *   import { l10n } from '../i18n';
 *   vscode.window.showInformationMessage(l10n('common.loading'));
 */

type MessageCatalog = Record<string, string>;

/** 语言设置项 id 与取值 */
export const LANGUAGE_CONFIG_KEY = 'dbclient.language';
export type LanguageSetting = 'auto' | 'zh' | 'en';

/** 英文词条（默认） */
const en: MessageCatalog = {
  // 通用
  'common.loading': 'Loading...',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.test': 'Test Connection',
  'common.ok': 'OK',
  'common.error': 'Error',

  // 连接表单
  'form.title': 'New Connection',
  'form.dbType': 'Database Type',
  'form.name': 'Name',
  'form.host': 'Host',
  'form.port': 'Port',
  'form.user': 'User',
  'form.password': 'Password',
  'form.database': 'Database',
  'form.sqlitePath': 'SQLite File Path',
  'form.testing': 'Testing...',
  'form.connected': 'Connected in {ms}ms',
  'form.saved': 'Saved connection "{name}".',

  // 连接树
  'tree.addGroup': 'Group name',
  'tree.moveGroup': 'Move connection to group',
  'tree.ungroup': 'Ungroup',
  'tree.deleteGroupTitle': 'Delete group "{name}"? Child groups and members will be ungrouped.',
  'tree.deleteGroupConfirm': 'Delete',

  // 命令
  'cmd.openEditorFirst': 'Open a SQL editor first.',
  'cmd.noConnection': 'No connection yet. Add one first.',
  'cmd.selectConnection': 'Select connection',
  'cmd.noHistory': 'No query history.',
  'cmd.pullDone': 'Data pulled and merged.',
  'cmd.pushDone': 'Data pushed.',
  'cmd.loggedOut': 'Logged out.',
  'cmd.loggedIn': 'Logged in.',
  'cmd.registered': 'Registered and logged in.',
  'cmd.pullNow': 'Pull remote data now?',
  'cmd.yes': 'Yes',
  'cmd.no': 'No',
  'cmd.masterPassword': 'Master password (used to encrypt/decrypt synced data)',
  'cmd.updated': 'Updated {table}.{column}',
  'cmd.groups': 'New Group',
};

/** 中文词条 */
const zh: MessageCatalog = {
  'common.loading': '加载中...',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.test': '测试连接',
  'common.ok': '确定',
  'common.error': '错误',

  'form.title': '新建连接',
  'form.dbType': '数据库类型',
  'form.name': '名称',
  'form.host': '主机',
  'form.port': '端口',
  'form.user': '用户',
  'form.password': '密码',
  'form.database': '数据库',
  'form.sqlitePath': 'SQLite 文件路径',
  'form.testing': '测试中...',
  'form.connected': '连接成功，耗时 {ms}ms',
  'form.saved': '已保存连接 "{name}"。',

  'tree.addGroup': '分组名称',
  'tree.moveGroup': '移动连接到分组',
  'tree.ungroup': '取消分组',
  'tree.deleteGroupTitle': '删除分组 "{name}"？子分组及其成员将被取消分组。',
  'tree.deleteGroupConfirm': '删除',

  'cmd.openEditorFirst': '请先打开 SQL 编辑器。',
  'cmd.noConnection': '暂无连接，请先添加。',
  'cmd.selectConnection': '选择连接',
  'cmd.noHistory': '暂无查询历史。',
  'cmd.pullDone': '已拉取并合并数据。',
  'cmd.pushDone': '已推送数据。',
  'cmd.loggedOut': '已登出。',
  'cmd.loggedIn': '已登录。',
  'cmd.registered': '已注册并登录。',
  'cmd.pullNow': '现在拉取远程数据？',
  'cmd.yes': '是',
  'cmd.no': '否',
  'cmd.masterPassword': '主密码（用于加密/解密同步数据）',
  'cmd.updated': '已更新 {table}.{column}',
  'cmd.groups': '新建分组',
};

/** 当前语言目录（惰性解析） */
let cachedCatalog: MessageCatalog | undefined;
let cachedIsZh: boolean | undefined;

/**
 * 解析当前实际语言：用户设置 > VSCode 界面语言。
 * 结果缓存，配置改变时通过 invalidateLanguage() 失效。
 */
export function resolveLanguage(): 'zh' | 'en' {
  const setting = vscode.workspace
    .getConfiguration()
    .get<LanguageSetting>(LANGUAGE_CONFIG_KEY, 'auto');
  if (setting === 'zh') return 'zh';
  if (setting === 'en') return 'en';
  // auto：跟随 VSCode 界面语言
  return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 判断当前是否为中文（含缓存） */
export function isZh(): boolean {
  if (cachedIsZh === undefined) {
    cachedIsZh = resolveLanguage() === 'zh';
  }
  return cachedIsZh;
}

/** 使语言缓存失效（配置变更时调用） */
export function invalidateLanguage(): void {
  cachedCatalog = undefined;
  cachedIsZh = undefined;
}

/**
 * 获取当前语言下的翻译文本。
 * 支持 {placeholder} 占位符替换。
 */
export function l10n(key: string, vars?: Record<string, string | number>): string {
  if (!cachedCatalog) {
    cachedCatalog = isZh() ? zh : en;
  }
  let text = cachedCatalog[key] || en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}