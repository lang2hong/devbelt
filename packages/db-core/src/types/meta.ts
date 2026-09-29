/**
 * 字段元信息（复用自原项目 common/typeDef.ts）。
 */
export interface FieldInfo {
  catalog: string;
  db: string;
  schema: string;
  table: string;
  orgTable: string;
  name: string;
  orgName: string;
  charsetNr: number;
  length: number;
  flags: number;
  decimals: number;
  default?: string;
  zeroFill: boolean;
  protocol41: boolean;
  type: number;
}

/** 列元信息 */
export interface ColumnMeta {
  name: string;
  simpleType: string;
  type: string;
  comment: string;
  key: string;
  nullable: string;
  maxLength: string;
  defaultValue: any;
  extra: any;
  isNotNull: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  pk: string;
}

/** 表元信息 */
export interface TableMeta {
  name: string;
  comment: string;
  table_rows?: string;
  auto_increment?: string;
  /** clustered bytes * pagesize */
  data_length?: string;
  /** clustered bytes * pagesize */
  index_length?: string;
}

/** 视图元信息 */
export interface ViewMeta extends TableMeta {
  /** pg only, material: material view */
  type?: string;
}

/** 函数/存储过程元信息 */
export interface RoutineMeta {
  name: string;
  /** FUNCTION | PROCEDURE */
  type: string;
  comment?: string;
}

/** 事件元信息（MySQL EVENT SCHEDULE） */
export interface EventMeta {
  name: string;
  definer?: string;
  eventType?: string;
  comment?: string;
}

/** 索引元信息 */
export interface IndexMeta {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  type?: string;
}

/** 触发器元信息 */
export interface TriggerMeta {
  name: string;
  /** 触发时机：BEFORE / AFTER / INSTEAD OF */
  timing?: string;
  /** 触发事件：INSERT / UPDATE / DELETE */
  event?: string;
  /** 关联表 */
  table?: string;
}

/** 用户元信息 */
export interface UserMeta {
  name: string;
  host?: string;
}

/** 外键关系 */
export interface ForeignKeyMeta {
  tableName: string;
  columnName: string;
  refTable: string;
  refColumn: string;
  /** 被引用表所在 schema（仅 PG；跨 schema 外键跳转需要）。 */
  refSchema?: string;
  /** 外键约束名（DROP FOREIGN KEY 需要） */
  constraintName?: string;
}

/** 本地保存的查询（Navicat Queries 分类的本地存储） */
export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connId: string;
  database?: string;
  /** 保存查询所属文件夹 id；未分组为 undefined */
  folderId?: string;
  /** 创建时间戳（ms） */
  createTime: number;
  /** 最近更新时间戳（ms），合并同步按此判定先后 */
  updateTime: number;
  /** 软删除墓碑：true 表示已删除，记录保留以跨端传播删除语义 */
  deleted?: boolean;
}