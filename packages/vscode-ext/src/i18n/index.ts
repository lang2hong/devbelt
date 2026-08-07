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
  'cmd.login': 'Login',
  'cmd.register': 'Register',
  'cmd.selectAction': 'Login or Register?',
  'cmd.pullNow': 'Pull remote data now?',
  'cmd.yes': 'Yes',
  'cmd.no': 'No',
  'cmd.masterPassword': 'Master password (used to encrypt/decrypt synced data)',
  'cmd.updated': 'Updated {table}.{column}',
  'cmd.groups': 'New Group',

  // 表操作
  'table.dropConfirm': 'Delete table "{name}"? This cannot be undone.',
  'table.delete': 'Delete',
  'table.renamePrompt': 'New table name:',
  'table.truncateConfirm': 'Truncate table "{name}"? All rows will be removed.',
  'table.truncate': 'Truncate',
  'table.dupPrompt': 'New table name (copy of "{name}"):',
  'table.viewData': 'View Data',
  'table.newTable': 'New Table',
  'table.dropTable': 'Delete Table',
  'table.renameTable': 'Rename Table',
  'table.truncateTable': 'Truncate Table',
  'table.dupTable': 'Duplicate Table',
  'table.structure': 'View Structure',

  // 连接操作
  'conn.edit': 'Edit Connection',
  'conn.delete': 'Delete Connection',
  'conn.deleteConfirm': 'Delete connection "{name}"?',
  'conn.close': 'Close Connection',
  'conn.closed': 'Connection "{name}" closed.',
  'conn.open': 'Open Connection',

  // 分类节点
  'cat.tables': 'Tables',
  'cat.views': 'Views',
  'cat.functions': 'Functions',
  'cat.events': 'Events',
  'cat.queries': 'Queries',

  // 查询操作
  'query.new': 'New Query',
  'query.namePrompt': 'Query name:',
  'query.sqlPrompt': 'SQL:',
  'query.delete': 'Delete Query',
  'query.deleteConfirm': 'Delete query "{name}"?',
  'query.open': 'Open Query',
  'query.edit': 'Edit Query',
  'query.rename': 'Rename Query',
  'query.renamePrompt': 'New query name:',

  // 视图操作
  'view.deleteConfirm': 'Delete view "{name}"?',
  'view.delete': 'Delete View',

  // 函数操作
  'routine.open': 'View Definition',
  'routine.delete': 'Delete Routine',
  'routine.deleteConfirm': 'Delete routine "{name}"?',

  // 事件操作
  'event.open': 'View Definition',
  'event.delete': 'Delete Event',
  'event.deleteConfirm': 'Delete event "{name}"?',

  // 数据库操作
  'db.create': 'New Database',
  'db.createPrompt': 'Database name:',
  'db.created': 'Database "{name}" created.',
  'db.drop': 'Drop Database',
  'db.dropConfirm': 'Drop database "{name}"? All data will be lost.',

  // 表 DDL
  'table.source': 'View DDL',

  // Mock 数据
  'mock.prompt': 'Number of rows to generate:',
  'mock.invalid': 'Please enter a valid number',
  'mock.done': '{count} row(s) of mock data inserted.',
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
  'cmd.login': '登录',
  'cmd.register': '注册',
  'cmd.selectAction': '登录还是注册？',
  'cmd.pullNow': '现在拉取远程数据？',
  'cmd.yes': '是',
  'cmd.no': '否',
  'cmd.masterPassword': '主密码（用于加密/解密同步数据）',
  'cmd.updated': '已更新 {table}.{column}',
  'cmd.groups': '新建分组',

  'table.dropConfirm': '删除表 "{name}"？此操作不可恢复。',
  'table.delete': '删除',
  'table.renamePrompt': '新表名：',
  'table.truncateConfirm': '清空表 "{name}"？所有数据将被移除。',
  'table.truncate': '清空',
  'table.dupPrompt': '新表名（复制自 "{name}"）：',
  'table.viewData': '查看数据',
  'table.newTable': '新建表',
  'table.dropTable': '删除表',
  'table.renameTable': '重命名表',
  'table.truncateTable': '清空表',
  'table.dupTable': '复制表',
  'table.structure': '查看表结构',

  // 连接操作
  'conn.edit': '编辑连接',
  'conn.delete': '删除连接',
  'conn.deleteConfirm': '删除连接 "{name}"？',
  'conn.close': '关闭连接',
  'conn.closed': '连接 "{name}" 已关闭。',
  'conn.open': '打开连接',

  // 分类节点
  'cat.tables': '表',
  'cat.views': '视图',
  'cat.functions': '函数',
  'cat.events': '事件',
  'cat.queries': '查询',

  // 查询操作
  'query.new': '新建查询',
  'query.namePrompt': '查询名称：',
  'query.sqlPrompt': 'SQL：',
  'query.delete': '删除查询',
  'query.deleteConfirm': '删除查询 "{name}"？',
  'query.open': '打开查询',
  'query.edit': '编辑查询',
  'query.rename': '重命名查询',
  'query.renamePrompt': '新查询名：',

  // 视图操作
  'view.deleteConfirm': '删除视图 "{name}"？',
  'view.delete': '删除视图',

  // 函数操作
  'routine.open': '查看定义',
  'routine.delete': '删除函数',
  'routine.deleteConfirm': '删除函数 "{name}"？',

  // 事件操作
  'event.open': '查看定义',
  'event.delete': '删除事件',
  'event.deleteConfirm': '删除事件 "{name}"？',

  // 数据库操作
  'db.create': '新建数据库',
  'db.createPrompt': '数据库名：',
  'db.created': '数据库 "{name}" 已创建。',
  'db.drop': '删除数据库',
  'db.dropConfirm': '删除数据库 "{name}"？所有数据将丢失。',

  // 表 DDL
  'table.source': '查看DDL',

  // Mock 数据
  'mock.prompt': '生成行数：',
  'mock.invalid': '请输入有效数字',
  'mock.done': '已插入 {count} 行 Mock 数据。',
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