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
  /** 参数签名（PG `pg_get_function_identity_arguments`；DROP 重载函数需要）。 */
  identityArgs?: string;
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
  /** PG（4B-2a）：访问方法（btree/hash/gin…）。 */
  method?: string;
  /** PG（4B-2a）：部分索引 WHERE 表达式（`pg_get_expr(indpred)`）；无则 undefined。 */
  predicate?: string;
  /**
   * PG（4B-2a）：逐部件定义（`pg_get_indexdef(oid, pos, true)`，含 opclass/DESC/NULLS）；
   * `isKey=false` 为 INCLUDE 列。其它方言不填，回退整串定义比较/生成。
   */
  keyParts?: { def: string; isKey: boolean }[];
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

/** 序列（PG）。数值以**字符串**保留（bigint 可超 JS number 精度）。 */
export interface SequenceMeta {
  name: string;
  /** 数值类型（bigint/smallint/integer），缺省 bigint。 */
  dataType?: string;
  startValue?: string | null;
  minValue?: string | null;
  maxValue?: string | null;
  incrementBy?: string | null;
  cycle?: boolean;
  cacheSize?: string | null;
  /** 序列当前值（同步后 setval 用）。 */
  lastValue?: string | null;
}

/** 表级约束（PK/UNIQUE/CHECK/FK），定义由数据库规范化输出。 */
/**
 * PG（4B-2b）：约束的结构化形状（FK 与 CHECK；存在时按结构比较/组合生成，缺失回退整串定义）。
 * PK/UNIQUE 不在此（含 INCLUDE/NULLS NOT DISTINCT 等版本相关细节，保留文本路径）。
 */
export interface ConstraintShape {
  /** FK：本表列（conkey 顺序）。 */
  columns?: string[];
  /** FK：被引用 schema/表/列。 */
  refSchema?: string;
  refTable?: string;
  refColumns?: string[];
  /** FK：a=NO ACTION / r=RESTRICT / c=CASCADE / n=SET NULL / d=SET DEFAULT。 */
  onUpdate?: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  onDelete?: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  /** FK：FULL / PARTIAL / SIMPLE。 */
  match?: 'FULL' | 'PARTIAL' | 'SIMPLE';
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  /** CHECK：表达式（pg_get_expr(conbin, conrelid)）。 */
  expression?: string;
  notValid?: boolean;
  noInherit?: boolean;
}

export interface ConstraintMeta extends ConstraintShape {
  tableName: string;
  name: string;
  /** p=primary, u=unique, c=check, f=foreign。 */
  type: 'p' | 'u' | 'c' | 'f';
  /** 规范化定义（如 `PRIMARY KEY (id)` / `FOREIGN KEY (a) REFERENCES s.b(id)`）。 */
  definition: string;
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