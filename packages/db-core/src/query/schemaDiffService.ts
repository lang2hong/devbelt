import type { MetadataService } from './metadataService.js';
import type { TableService } from './tableService.js';
import type { ColumnMeta } from '../types/meta.js';
import { validateIdent } from '../utils/validate.js';
import { validateColumnType } from './columnSpec.js';
import type { ColumnSpec } from './columnSpec.js';
import { renderColumnAttributes } from './columnSpec.js';
import { DatabaseType } from '../types/connection.js';
import { MysqlDialect } from '../dialect/mysqlDialect.js';
import { PostgreSqlDialect } from '../dialect/postgreSqlDialect.js';
import type { SqlDialect } from '../dialect/sqlDialect.js';
import { sqlCommentSafe } from '../sql/index.js';

const MYSQL_DIALECT = new MysqlDialect();
const PG_DIALECT = new PostgreSqlDialect();
const MYSQL_ESC = (v: any): string => MYSQL_DIALECT.escapeValue(v);
const PG_ESC = (v: any): string => PG_DIALECT.escapeValue(v);

/** 列差异 */
export interface ColumnDiff {
  columnName: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  sourceType?: string;
  targetType?: string;
  /** 源列是否 NOT NULL（生成同步 DDL 时需要一并带上，否则只同步类型会丢约束）。 */
  sourceNotNull?: boolean;
  /** 源列默认值；新增/改列时一并同步，避免只发类型导致默认值丢失。 */
  sourceDefault?: any;
  /** 源列是否自增（MySQL AUTO_INCREMENT）。 */
  sourceAutoIncrement?: boolean;
  /** 源列注释。 */
  sourceComment?: string;
  /** 目标列是否 NOT NULL（判断是否需要 SET/DROP NOT NULL）。 */
  targetNotNull?: boolean;
  /** 目标列默认值（判断 PG SET DEFAULT / DROP DEFAULT）。 */
  targetDefault?: any;
  /** 目标列注释（判断 PG COMMENT ON COLUMN）。 */
  targetComment?: string;
}

/** 默认值归一化：null/undefined → ''，去首尾空白。 */
function normDefault(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

/** 注释归一化：null/undefined → ''。 */
function normComment(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** 表差异 */
export interface TableDiff {
  tableName: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  columns: ColumnDiff[];
}

/** 字段感知的跨 schema 比较归一化器（类型/默认值/注释分别处理）。 */
interface ColumnNormalizers {
  type(v: unknown): string;
  default(v: unknown): string;
  comment(v: unknown): string;
}

/**
 * 结构差异服务：比对两个数据库的表结构，生成同步 SQL。
 *
 * 设计模式：策略模式（纯比较逻辑，不依赖具体连接）
 */
export class SchemaDiffService {
  /**
   * 比对两个数据库（MySQL/SQLite）或两个 schema（PG）的表结构差异。
   * @param sourceMeta 源库元数据服务
   * @param sourceDb 源库名（PG 下为库名，仅用于展示；对象作用域由 `sourceSchema` 决定）
   * @param targetMeta 目标库元数据服务
   * @param targetDb 目标库名
   * @param sourceSchema PG：源 schema（同连接跨 schema 对比）
   * @param targetSchema PG：目标 schema
   */
  static async diff(
    sourceMeta: MetadataService,
    sourceDb: string,
    targetMeta: MetadataService,
    targetDb: string,
    sourceSchema?: string,
    targetSchema?: string,
  ): Promise<TableDiff[]> {
    const [sourceTables, targetTables] = await Promise.all([
      sourceMeta.getTables(sourceDb, sourceSchema),
      targetMeta.getTables(targetDb, targetSchema),
    ]);

    const sourceNames = new Set(sourceTables.map((t) => t.name));
    const targetNames = new Set(targetTables.map((t) => t.name));
    const result: TableDiff[] = [];

    // 源库有、目标无 → added
    for (const t of sourceTables) {
      if (!targetNames.has(t.name)) {
        result.push({ tableName: t.name, status: 'added', columns: [] });
      }
    }
    // 目标有、源库无 → removed
    for (const t of targetTables) {
      if (!sourceNames.has(t.name)) {
        result.push({ tableName: t.name, status: 'removed', columns: [] });
      }
    }
    // 都有 → 比较 columns
    for (const t of sourceTables) {
      if (!targetNames.has(t.name)) continue;
      const [sourceCols, targetCols] = await Promise.all([
        sourceMeta.getColumns(t.name, sourceDb, sourceSchema),
        targetMeta.getColumns(t.name, targetDb, targetSchema),
      ]);
      const colDiffs = this.diffColumns(sourceCols, targetCols, makeSchemaNormalizers(sourceSchema, targetSchema));
      result.push({
        tableName: t.name,
        status: colDiffs.some((c) => c.status !== 'unchanged') ? 'changed' : 'unchanged',
        columns: colDiffs,
      });
    }

    return result;
  }

  /** 比对列差异。`norm` 用于跨 schema 比较：按字段定向抹掉 schema 前缀（不会误伤字面量/注释）。 */
  private static diffColumns(source: ColumnMeta[], target: ColumnMeta[], norm: ColumnNormalizers = plainNormalizers()): ColumnDiff[] {
    const sourceMap = new Map(source.map((c) => [c.name, c]));
    const targetMap = new Map(target.map((c) => [c.name, c]));
    const diffs: ColumnDiff[] = [];

    const attrs = (c: ColumnMeta) => ({
        sourceDefault: c.defaultValue,
        sourceAutoIncrement: !!c.isAutoIncrement,
        sourceComment: c.comment,
      });
    for (const [name, srcCol] of sourceMap) {
      const tgtCol = targetMap.get(name);
      const notNull = !!srcCol.isNotNull;
      if (!tgtCol) {
        diffs.push({ columnName: name, status: 'added', sourceType: srcCol.type, sourceNotNull: notNull, ...attrs(srcCol) });
      } else {
        // 变更判定：类型 / NOT NULL / 自增 / 默认值 / 注释（后三者此前未比较，
        // 只改默认值或注释会被误判 unchanged、永不同步）。
        const changed =
          norm.type(srcCol.type) !== norm.type(tgtCol.type)
          || !!tgtCol.isNotNull !== notNull
          || !!srcCol.isAutoIncrement !== !!tgtCol.isAutoIncrement
          || norm.default(srcCol.defaultValue) !== norm.default(tgtCol.defaultValue)
          || norm.comment(srcCol.comment) !== norm.comment(tgtCol.comment);
        if (changed) {
          diffs.push({
            columnName: name,
            status: 'changed',
            sourceType: srcCol.type,
            targetType: tgtCol.type,
            sourceNotNull: notNull,
            targetNotNull: !!tgtCol.isNotNull,
            targetDefault: tgtCol.defaultValue,
            targetComment: tgtCol.comment,
            ...attrs(srcCol),
          });
        } else {
          diffs.push({ columnName: name, status: 'unchanged' });
        }
      }
    }
    for (const [name, tgtCol] of targetMap) {
      if (!sourceMap.has(name)) {
        diffs.push({ columnName: name, status: 'removed', targetType: tgtCol.type });
      }
    }

    return diffs;
  }

  /**
   * 根据差异生成同步 SQL（将源库结构同步到目标库）。
   * @param diffs 差异列表
   * @param targetDb 目标库名（MySQL/SQLite 用作限定；PG 忽略，见 opts.targetSchema）
   * @param sourceTableService 源库表服务（用于获取新增表的 DDL）
   * @param sourceDb 源库名
   * @param targetDialect 目标方言（MySQL NO_BACKSLASH_ESCAPES 时按目标模式转义）
   * @param opts PG：`sourceSchema`/`targetSchema`（同连接跨 schema 对比/同步）
   */
  static async generateSyncSql(
    diffs: TableDiff[],
    targetDb: string,
    sourceTableService: TableService,
    sourceDb: string,
    targetDialect?: SqlDialect,
    opts: { sourceSchema?: string; targetSchema?: string } = {},
  ): Promise<string> {
    if (!sourceTableService.supports('schemaSync')) {
      throw new Error('Schema sync SQL is not supported for this database');
    }
    // PG 走自己的 DDL 生成：标识符用双引号；有 targetSchema 时限定目标 schema，
    // 否则不限定库名、走 search_path。改列用 ALTER COLUMN TYPE / SET|DROP NOT NULL。
    if (sourceTableService.dbType === DatabaseType.PG) {
      return this.generatePgSyncSql(diffs, targetDb, sourceTableService, sourceDb, opts);
    }
    if (sourceTableService.dbType === DatabaseType.SQLITE) {
      return this.generateSqliteSyncSql(diffs, sourceTableService, sourceDb);
    }
    const targetDbIdent = validateIdent(targetDb);
    // 目标 MySQL 若是 NO_BACKSLASH_ESCAPES，默认值/注释的字面量必须按该模式转义。
    const mysqlEsc = targetDialect ? (v: any) => targetDialect.escapeValue(v) : MYSQL_ESC;
    const parts: string[] = [];
    parts.push(`-- Schema sync: ${sqlCommentSafe(sourceDb)} → ${sqlCommentSafe(targetDb)}`);
    parts.push('');

    for (const d of diffs) {
      const tableIdent = validateIdent(d.tableName);
      if (d.status === 'added') {
        const ddl = await sourceTableService.getCreateSql(d.tableName, sourceDb);
        parts.push(`-- Add table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS \`${targetDbIdent}\`.\`${tableIdent}\`;`);
        // 只给表头（CREATE TABLE 后的首个反引号标识符）加库前缀；列名不能被拼接 `db.` 前缀。
        parts.push(ddl.replace(/^CREATE\s+TABLE\s+`([^`]+)`/i, `CREATE TABLE \`${targetDbIdent}\`.\`$1\``) + ';');
        parts.push('');
      } else if (d.status === 'removed') {
        parts.push(`-- Drop table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS \`${targetDbIdent}\`.\`${tableIdent}\`;`);
        parts.push('');
      } else if (d.status === 'changed') {
        const changes: string[] = [];
        const warnings: string[] = [];
        for (const c of d.columns) {
          const colIdent = validateIdent(c.columnName);
          // sourceType 来自源库 information_schema 列元数据，属**跨信任面**（源库可能不可信）。
          // 类型是必须裸拼进 DDL 的部分，故与用户输入路径同一门槛校验（括号/引号闭合、白名单字符）。
          if (c.status === 'added') {
            const spec: ColumnSpec = {
              type: c.sourceType || 'TEXT',
              notNull: c.sourceNotNull,
              autoIncrement: c.sourceAutoIncrement,
              defaultValue: c.sourceDefault,
              comment: c.sourceComment,
            };
            // 有数据的表上 `ADD COLUMN ... NOT NULL` 无默认值会失败（暗含默认值不可靠）；
            // 降级为可空列并给出告警，而不是发出不可执行的 DDL。
            if (spec.notNull && hasNoDefault(spec) && !spec.autoIncrement) {
              changes.push(`  ADD COLUMN \`${colIdent}\` ${renderColumnAttributes({ ...spec, notNull: false }, DatabaseType.MYSQL, mysqlEsc)}`);
              warnings.push(`-- WARN: "${c.columnName}" is NOT NULL on the source but has no default; add a DEFAULT or backfill values, then enforce NOT NULL.`);
            } else {
              changes.push(`  ADD COLUMN \`${colIdent}\` ${renderColumnAttributes(spec, DatabaseType.MYSQL, mysqlEsc)}`);
            }
          } else if (c.status === 'removed') {
            changes.push(`  DROP COLUMN \`${colIdent}\``);
          } else if (c.status === 'changed') {
            // MODIFY 必须写全（类型 + NULL/NOT NULL + DEFAULT + AUTO_INCREMENT + COMMENT），
            // 否则只给类型会把这些属性静默丢弃。
            const spec: ColumnSpec = {
              type: c.sourceType || 'TEXT',
              notNull: c.sourceNotNull,
              autoIncrement: c.sourceAutoIncrement,
              defaultValue: c.sourceDefault,
              comment: c.sourceComment,
            };
            changes.push(`  MODIFY COLUMN \`${colIdent}\` ${renderColumnAttributes(spec, DatabaseType.MYSQL, mysqlEsc)}`);
          }
        }
        if (changes.length) {
          parts.push(`-- Alter table: ${d.tableName}`);
          parts.push(...warnings);
          parts.push(`ALTER TABLE \`${targetDbIdent}\`.\`${tableIdent}\` ` + changes.join(',\n') + ';');
          parts.push('');
        }
      }
    }

    if (parts.length <= 2) {
      parts.push('-- No differences found. Schemas are in sync.');
    }

    return parts.join('\n');
  }

  /**
   * 生成 PG 的 schema 同步 DDL。
   *
   * 无 `targetSchema` 时不限定库名（PG 的「库」不能跨库引用，目标由连接的 search_path 决定）；
   * 有 `targetSchema` 时把 DDL 限定到目标 schema（同连接跨 schema 对比/同步）。
   * 改列分为「改类型」与「SET/DROP NOT NULL」两步，ADD/DROP 列同理。
   */
  private static async generatePgSyncSql(
    diffs: TableDiff[],
    _targetDb: string,
    sourceTableService: TableService,
    sourceDb: string,
    opts: { sourceSchema?: string; targetSchema?: string } = {},
  ): Promise<string> {
    const wrap = (id: string) => sourceTableService.wrapIdentifier(id);
    const wrapSchema = (id: string) => sourceTableService.wrapSchemaIdentifier(id);
    const target = opts.targetSchema;
    const targetTable = (name: string): string => (target ? `${wrapSchema(target)}.${wrap(name)}` : wrap(name));
    // 跨 schema：把默认表达式/类型名里的源 schema 前缀改写到目标 schema
    // （如 nextval('s1.x_seq') → nextval('s2.x_seq')）。
    const rewrite = (text: unknown): string => rewritePgSchemaRefs(toCompareString(text), opts.sourceSchema, target);
    const parts: string[] = [
      `-- Schema sync: ${sqlCommentSafe(sourceDb)} → ${target ? wrapSchema(target) : 'target'}`,
      '',
    ];
    for (const d of diffs) {
      const table = targetTable(d.tableName);
if (d.status === 'added') {
        // 表头直接生成到目标 schema（列仍按 sourceSchema 读取），不做脆弱的文本替换。
        const ddl = rewrite(await sourceTableService.getCreateSql(d.tableName, sourceDb, opts.sourceSchema, opts.targetSchema));
        parts.push(`-- Add table: ${d.tableName}`);
        // N2（部分）：serial 默认值引用的目标序列不存在时 CREATE TABLE 会因 regclass 解析失败；
        // 先建序列（空序列；值推进 setval 未处理，见范围说明）。
        for (const q of new Set(extractNextvalSequences(ddl))) parts.push(`CREATE SEQUENCE IF NOT EXISTS ${q};`);
        parts.push(`DROP TABLE IF EXISTS ${table};`);
        parts.push(ddl.replace(/;\s*$/, '') + ';');
        parts.push('');
      } else if (d.status === 'removed') {
        parts.push(`-- Drop table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS ${table};`);
        parts.push('');
      } else if (d.status === 'changed') {
        const actions: string[] = [];
        const warnings: string[] = [];
        const extra: string[] = [];
        for (const c of d.columns) {
          const col = wrap(c.columnName);
          const type = validateColumnType(rewrite(c.sourceType) || 'text');
          if (c.status === 'added') {
            const spec: ColumnSpec = {
              type: rewrite(c.sourceType) || 'text',
              notNull: c.sourceNotNull,
              autoIncrement: c.sourceAutoIncrement,
              defaultValue: rewrite(c.sourceDefault),
              comment: c.sourceComment,
            };
            // PG 在有数据的表上加 NOT NULL 且无默认值会直接失败。
            if (spec.notNull && hasNoDefault(spec) && !spec.autoIncrement) {
              actions.push(`ADD COLUMN ${col} ${renderColumnAttributes({ ...spec, notNull: false }, DatabaseType.PG, PG_ESC, false, true)}`);
              warnings.push(`-- WARN: "${c.columnName}" is NOT NULL on the source but has no default; add a DEFAULT or backfill values, then enforce NOT NULL.`);
            } else {
              actions.push(`ADD COLUMN ${col} ${renderColumnAttributes(spec, DatabaseType.PG, PG_ESC, false, true)}`);
            }
          } else if (c.status === 'removed') {
            actions.push(`DROP COLUMN ${col}`);
          } else if (c.status === 'changed') {
            const srcType = rewrite(c.sourceType);
            const tgtType = rewrite(c.targetType);
            const normalize = (t?: string) => String(t || '').trim().toLowerCase();
            const base = (t?: string) => normalize(t).split('(')[0].trim();
            // 完整类型（含长度/精度）不同就必须改类型：仅 `varchar(100) → varchar(255)`
            // 这类差异此前被 base() 抹平，diffColumns 判了 changed 却不生成任何动作。
            if (normalize(tgtType) !== normalize(srcType)) {
              actions.push(`ALTER COLUMN ${col} TYPE ${type}`);
              // 仅基础类型不同才提示可能需要 USING/数据清理；纯长度/精度变化一般可安全转换。
              if (base(tgtType) && base(srcType) && base(tgtType) !== base(srcType)) {
                warnings.push(`-- WARN: type of "${c.columnName}" changes ${tgtType} → ${srcType}; may require USING / data cleanup.`);
              }
            }
            if (!!c.sourceNotNull !== !!c.targetNotNull) {
              actions.push(`ALTER COLUMN ${col} ${c.sourceNotNull ? 'SET' : 'DROP'} NOT NULL`);
            }
            // 默认值差异：源为 PG，表达式改写到目标 schema；无默认值则 DROP。
            if (normDefault(c.sourceDefault) !== normDefault(c.targetDefault)) {
              actions.push(normDefault(c.sourceDefault) !== ''
                ? `ALTER COLUMN ${col} SET DEFAULT ${rewrite(c.sourceDefault)}`
                : `ALTER COLUMN ${col} DROP DEFAULT`);
            }
            // 注释是独立语句，不能并入 ALTER TABLE 子命令列表。
            if (normComment(c.sourceComment) !== normComment(c.targetComment)) {
              extra.push(`COMMENT ON COLUMN ${table}.${col} IS ${normComment(c.sourceComment) !== '' ? PG_ESC(c.sourceComment) : 'NULL'};`);
            }
          }
        }
        if (actions.length || extra.length) {
          parts.push(`-- Alter table: ${d.tableName}`);
          parts.push(...warnings);
          if (actions.length) parts.push(`ALTER TABLE ${table} ${actions.join(', ')};`);
          parts.push(...extra);
          parts.push('');
        }
      }
    }
    if (parts.length <= 2) {
      parts.push('-- No differences found. Schemas are in sync.');
    }
    return parts.join('\n');
  }

  /**
   * 生成 SQLite 的 schema 同步 DDL。
   *
   * SQLite 只支持有限的 ALTER：ADD COLUMN、DROP COLUMN（3.35+）、RENAME。改类型/约束
   * 需要重建表，这里**不生成**、只留注释说明（避免发出不可执行/损坏的 SQL）。表的新增/
   * 删除按不限定名（恢复到当前库）。
   */
  private static async generateSqliteSyncSql(
    diffs: TableDiff[],
    sourceTableService: TableService,
    sourceDb: string,
  ): Promise<string> {
    const wrap = (id: string) => sourceTableService.wrapIdentifier(id);
    const parts: string[] = [`-- Schema sync: ${sqlCommentSafe(sourceDb)} → target (SQLite)`, ''];
    for (const d of diffs) {
      const table = wrap(d.tableName);
      if (d.status === 'added') {
        const ddl = await sourceTableService.getCreateSql(d.tableName, sourceDb);
        parts.push(`-- Add table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS ${table};`);
        parts.push(ddl.replace(/;\s*$/, '') + ';');
        parts.push('');
      } else if (d.status === 'removed') {
        parts.push(`-- Drop table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS ${table};`);
        parts.push('');
      } else if (d.status === 'changed') {
        const actions: string[] = [];
        for (const c of d.columns) {
          const col = wrap(c.columnName);
          if (c.status === 'added') {
            // 注意：SQLite 的 ADD COLUMN 不允许 NOT NULL 且无默认值的列；有默认值时可加。
            actions.push(`ALTER TABLE ${table} ADD COLUMN ${col} ${validateColumnType(c.sourceType || 'TEXT')};`);
          } else if (c.status === 'removed') {
            actions.push(`ALTER TABLE ${table} DROP COLUMN ${col};`);
          } else if (c.status === 'changed') {
            const what: string[] = [];
            if (String(c.targetType) !== String(c.sourceType)) what.push(`${c.targetType} → ${c.sourceType}`);
            if (!!c.targetNotNull !== !!c.sourceNotNull) what.push('NOT NULL');
            if (normDefault(c.targetDefault) !== normDefault(c.sourceDefault)) what.push('DEFAULT');
            if (normComment(c.targetComment) !== normComment(c.sourceComment)) what.push('COMMENT');
            parts.push(`-- Cannot alter column "${c.columnName}" on SQLite (${what.join(', ') || 'attributes'}); table rebuild required.`);
          }
        }
        if (actions.length) {
          parts.push(`-- Alter table: ${d.tableName}`);
          parts.push(...actions);
          parts.push('');
        }
      }
    }
    if (parts.length <= 2) {
      parts.push('-- No differences found. Schemas are in sync.');
    }
    return parts.join('\n');
  }
}

/** 列规格是否「没有默认值」（空串/null/undefined 都算无）。 */
function hasNoDefault(spec: ColumnSpec): boolean {
  return spec.defaultValue === undefined || spec.defaultValue === null || spec.defaultValue === '';
}

/** null/undefined → ''，其余 String()。 */
function toCompareString(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** 提取 DDL 里 `nextval('<seq>'::regclass)` 的序列名（用于先生成 CREATE SEQUENCE）。 */
function extractNextvalSequences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/nextval\('([^']+)'::regclass\)/g)) out.push(m[1]);
  return out;
}

/** 无 schema 时的普通归一化（行为与旧版一致：类型字符串化、默认值 trim、注释原样）。 */
function plainNormalizers(): ColumnNormalizers {
  return {
    type: toCompareString,
    default: (v) => normDefault(toCompareString(v)),
    comment: (v) => normComment(toCompareString(v)),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 对字符串字面量（`'...'`，含 `''` 转义）**之外**的片段应用 `transform`，
 * 字面量原样保留。用于避免把字面量内的 `app.` 当成 schema 限定改写。
 */
function rewriteOutsideLiterals(text: string, transform: (segment: string) => string): string {
  let out = '';
  let buf = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === "'") {
      out += transform(buf);
      buf = '';
      let lit = "'";
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { lit += "''"; i += 2; continue; }
          lit += "'"; i++;
          break;
        }
        lit += text[i]; i++;
      }
      out += lit;
      continue;
    }
    buf += text[i]; i++;
  }
  return out + transform(buf);
}

/** 字面量内 `schema.seq` / `"schema".seq` / `"schema"."seq"` → 去掉 schema 限定。 */
function stripSchemaInLiteral(lit: string, schemas: readonly (string | undefined)[]): string {
  for (const sc of schemas) {
    if (!sc) continue;
    const q = `"${sc.replace(/"/g, '""')}"`;
    if (lit.startsWith(`${q}.`)) return lit.slice(q.length + 1);
    if (lit.startsWith(`${sc}.`)) return lit.slice(sc.length + 1);
  }
  return lit;
}

/** 只从 `nextval('<schema>.<seq>'::regclass)` 的字面量里剥掉 schema 前缀（不碰其它字面量）。 */
function stripRegclassSchema(text: string, schemas: readonly (string | undefined)[]): string {
  return text.replace(/nextval\('([^']*)'::regclass\)/g, (_m, lit: string) => `nextval('${stripSchemaInLiteral(lit, schemas)}'::regclass)`);
}

/**
 * 去掉**标识符上下文**里的 schema 限定（类型名如 `app.myenum`）：仅在字符串字面量之外，
 * 且前置字符非 `[\w$"']` 时匹配。字面量内的 `app.` 完全不动。
 */
function stripIdentifierSchema(text: string, schemas: readonly (string | undefined)[]): string {
  const boundary = '(?<![\\w$"\'])';
  const patterns = schemas
    .filter((sc): sc is string => !!sc)
    .flatMap((sc) => [`"${sc.replace(/"/g, '""')}"`, sc])
    .map((p) => new RegExp(`${boundary}${escapeRe(p)}\\.`, 'g'));
  return rewriteOutsideLiterals(text, (seg) => {
    let s = seg;
    for (const re of patterns) s = s.replace(re, '');
    return s;
  });
}

/** 字段感知的跨 schema 比较归一化器：类型/默认值按定向形态归一，注释原样。 */
function makeSchemaNormalizers(sourceSchema?: string, targetSchema?: string): ColumnNormalizers {
  if (!sourceSchema && !targetSchema) return plainNormalizers();
  const schemas = [sourceSchema, targetSchema];
  return {
    type: (v) => stripIdentifierSchema(toCompareString(v), schemas),
    // 默认值：先剥 nextval 字面量里的 schema，再剥 `::类型` 的标识符限定（enum/domain 跨 schema 等价）。
    default: (v) => normDefault(stripIdentifierSchema(stripRegclassSchema(toCompareString(v), schemas), schemas)),
    comment: (v) => normComment(toCompareString(v)),
  };
}

/**
 * 把已知形态里的源 schema 前缀改写为目标 schema：
 * - `nextval('<from>.<seq>'::regclass)` 字面量（带 schema → 改写；**未带 schema → 视为源 schema 对象，补目标 schema**）；
 * - 字符串字面量之外的标识符上下文类型名限定。
 * 不做无边界子串替换，避免误改 `'see app.example.com'` 等字面量。
 */
function rewritePgSchemaRefs(text: string, from?: string, to?: string): string {
  if (!text || !from || !to || from === to) return text;
  const fromQ = `"${from.replace(/"/g, '""')}"`;
  const toQ = `"${to.replace(/"/g, '""')}"`;
  const s = text.replace(/nextval\('([^']*)'::regclass\)/g, (_m, lit: string) => {
    let l = lit;
    if (l.startsWith(`${fromQ}.`)) l = `${toQ}.${l.slice(fromQ.length + 1)}`;
    else if (l.startsWith(`${from}.`)) l = `${to}.${l.slice(from.length + 1)}`;
    else if (!l.includes('.')) l = `${to}.${l}`; // 未限定（源 schema 在 search_path 时的输出）→ 补目标 schema
    return `nextval('${l}'::regclass)`;
  });
  const boundary = '(?<![\\w$"\'])';
  const fromPats = [fromQ, from].map((p) => new RegExp(`${boundary}${escapeRe(p)}\\.`, 'g'));
  return rewriteOutsideLiterals(s, (seg) => {
    let out = seg;
    fromPats.forEach((re, idx) => { out = out.replace(re, idx === 0 ? `${toQ}.` : `${to}.`); });
    return out;
  });
}
