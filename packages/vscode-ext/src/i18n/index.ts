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
  'conn.refresh': 'Refresh Connection',
  'conn.newQuery': 'New Query',

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

  // 用户操作
  'user.namePrompt': 'User name:',
  'user.passwordPrompt': 'Password:',
  'user.hostPrompt': 'Host (default %):',
  'user.privPrompt': 'Privilege (e.g. ALL PRIVILEGES, SELECT, INSERT):',
  'user.createTitle': 'Create User',
  'user.grantTitle': 'Grant',
  'user.created': 'User "{name}" created.',
  'user.drop': 'Delete User',
  'user.dropConfirm': 'Delete user "{name}"?',
  'user.passwordChanged': 'Password changed for "{name}".',
  'user.granted': 'Granted {priv} to "{name}".',
  'user.revoked': 'Revoked {priv} from "{name}".',

  // 用户分类
  'cat.users': 'Users',

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

  // 导入/导出
  'export.structureOnly': 'Structure Only',
  'export.structureData': 'Structure + Data',
  'export.dataOnly': 'Data Only',
  'export.choose': 'Choose export type',
  'import.done': 'Imported {count} statement(s).',
  'import.chooseFormat': 'Choose import format',
  'export.chooseFormat': 'Choose export format',
  'import.formatSql': 'Run a SQL script',
  'import.formatCsv': 'Map CSV fields into a table',
  'import.formatJson': 'Map JSON fields into a table',
  'export.formatSql': 'SQL statements compatible with the connection dialect',
  'export.formatCsv': 'RFC 4180-compatible comma-separated values',
  'export.formatJson': 'Formatted JSON array',
  'import.selectFile': 'Select import file',
  'import.firstRowHeader': 'First row contains field names',
  'import.noHeader': 'First row is data',
  'import.headerChoice': 'How should CSV fields be read?',
  'import.selectDatabase': 'Choose destination database',
  'import.selectTable': 'Choose destination table',
  'import.skipField': 'Skip this field',
  'import.preview': 'Import {rows} row(s) with: {fields}',
  'import.run': 'Import',
  'import.progress': 'Importing data',
  'import.rowsDone': 'Imported {count} row(s).',
  'import.parseFailed': 'Cannot read import file: {message}',
  'import.noRows': 'The selected file contains no data rows.',
  'import.rolledBack': 'Import was rolled back at source row {row}. See the error report for details.',
  'import.failed': 'Import failed: {message}',
  'import.failedStatement': 'Import failed after {count} statement(s): {message}',
  'export.selectDatabase': 'Choose source database',
  'export.selectTables': 'Choose tables to export',
  'export.selectFolder': 'Select export folder',
  'export.progress': 'Exporting data',
  'export.done': 'Exported {count} table(s).',
  'export.failed': 'Export failed: {message}',
  'transfer.cancelled': 'Transfer cancelled.',
  'conn.exportNone': 'No connections to export.',
  'conn.exportPick': 'Select connections to export',
  'conn.exportNoSecrets': 'Without passwords',
  'conn.exportWithSecrets': 'Include passwords',
  'conn.exportSecretsPrompt': 'Include passwords in the export file?',
  'conn.exportSecretsWarning': 'The export file will contain plaintext passwords. Store it securely.',
  'conn.exportContinue': 'Export with passwords',
  'conn.exportDone': 'Exported {count} connection(s).',
  'conn.importOpen': 'Select connection file',
  'conn.importInvalid': 'Invalid connection file.',
  'conn.importDone': 'Imported {count} connection(s).',
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
  'conn.refresh': '刷新连接',
  'conn.newQuery': '新建查询',

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

  // 用户操作
  'user.namePrompt': '用户名：',
  'user.passwordPrompt': '密码：',
  'user.hostPrompt': '主机（默认 %）：',
  'user.privPrompt': '权限（如 ALL PRIVILEGES, SELECT, INSERT）：',
  'user.createTitle': '创建用户',
  'user.grantTitle': '授权',
  'user.created': '用户 "{name}" 已创建。',
  'user.drop': '删除用户',
  'user.dropConfirm': '删除用户 "{name}"？',
  'user.passwordChanged': '"{name}" 密码已修改。',
  'user.granted': '已授予 "{name}" {priv} 权限。',
  'user.revoked': '已撤销 "{name}" 的 {priv} 权限。',

  // 用户分类
  'cat.users': '用户',

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

  // 导入/导出
  'export.structureOnly': '仅结构',
  'export.structureData': '结构+数据',
  'export.dataOnly': '仅数据',
  'export.choose': '选择导出类型',
  'import.done': '已导入 {count} 条语句。',
  'import.chooseFormat': '选择导入格式',
  'export.chooseFormat': '选择导出格式',
  'import.formatSql': '执行 SQL 脚本',
  'import.formatCsv': '将 CSV 字段映射到表',
  'import.formatJson': '将 JSON 字段映射到表',
  'export.formatSql': '生成与当前连接方言兼容的 SQL 语句',
  'export.formatCsv': '导出 RFC 4180 兼容的逗号分隔值',
  'export.formatJson': '导出格式化 JSON 数组',
  'import.selectFile': '选择导入文件',
  'import.firstRowHeader': '第一行包含字段名',
  'import.noHeader': '第一行是数据',
  'import.headerChoice': '如何读取 CSV 字段？',
  'import.selectDatabase': '选择目标数据库',
  'import.selectTable': '选择目标表',
  'import.skipField': '跳过此字段',
  'import.preview': '将导入 {rows} 行，字段映射：{fields}',
  'import.run': '导入',
  'import.progress': '正在导入数据',
  'import.rowsDone': '已导入 {count} 行。',
  'import.parseFailed': '无法读取导入文件：{message}',
  'import.noRows': '所选文件不包含数据行。',
  'import.rolledBack': '已在源文件第 {row} 行回滚导入。详见错误报告。',
  'import.failed': '导入失败：{message}',
  'import.failedStatement': '导入执行至第 {count} 条语句时失败：{message}',
  'export.selectDatabase': '选择源数据库',
  'export.selectTables': '选择要导出的表',
  'export.selectFolder': '选择导出文件夹',
  'export.progress': '正在导出数据',
  'export.done': '已导出 {count} 张表。',
  'export.failed': '导出失败：{message}',
  'transfer.cancelled': '传输已取消。',
  'conn.exportNone': '没有可导出的连接。',
  'conn.exportPick': '选择要导出的连接',
  'conn.exportNoSecrets': '不含密码',
  'conn.exportWithSecrets': '包含密码',
  'conn.exportSecretsPrompt': '导出文件中是否包含密码？',
  'conn.exportSecretsWarning': '导出文件将包含明文密码，请妥善保管。',
  'conn.exportContinue': '导出并包含密码',
  'conn.exportDone': '已导出 {count} 个连接。',
  'conn.importOpen': '选择连接文件',
  'conn.importInvalid': '连接文件无效。',
  'conn.importDone': '已导入 {count} 个连接。',
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
