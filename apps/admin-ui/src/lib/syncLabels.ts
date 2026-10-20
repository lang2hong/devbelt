/** 同步实体类型的中文展示名（与服务端 entity_kind 对齐）。 */
const SYNC_KIND_LABELS: Record<string, string> = {
  connection: '数据库连接',
  group: '连接分组',
  queryFolder: '查询文件夹',
  query: '保存查询',
  authenticatorEntry: '验证器条目',
  authenticatorGroup: '验证器分组',
  authenticatorTag: '验证器标签',
  schemaNotes: '表结构备注',
  aiModelAccess: 'AI 模型配置',
  // 兼容历史记录里出现过的类名（旧客户端/旧测试数据）。
  SavedConnection: '数据库连接',
  ConnectionGroup: '连接分组',
  SavedQuery: '保存查询',
  QueryFolder: '查询文件夹',
  AuthenticatorEntry: '验证器条目',
  AuthenticatorGroup: '验证器分组',
  AuthenticatorTag: '验证器标签',
  TableNote: '表结构备注',
  AiModelAccess: 'AI 模型配置',
};

/**
 * 同步记录类型标签。
 * - 005 迁移前写入的旧记录没有 entity_kind，标为“历史记录”，不冒充未知类型。
 * - 未知值保留原始类型名，便于后续排查/补映射。
 */
export function syncKindLabel(kind: string | null | undefined): string {
  if (!kind) return '历史记录（类型未标注）';
  return SYNC_KIND_LABELS[kind] ?? `其他类型（${kind}）`;
}