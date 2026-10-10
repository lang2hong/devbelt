import type { MetadataService } from './metadataService.js';
import type { TableService } from './tableService.js';
import type { ColumnMeta, IndexMeta, SequenceMeta, ConstraintMeta, ConstraintShape } from '../types/meta.js';
import { validateIdent, validateSchemaIdent } from '../utils/validate.js';
import { validateColumnType } from './columnSpec.js';
import type { ColumnSpec } from './columnSpec.js';
import { renderColumnAttributes } from './columnSpec.js';
import { DatabaseType } from '../types/connection.js';
import { MysqlDialect } from '../dialect/mysqlDialect.js';
import { PostgreSqlDialect } from '../dialect/postgreSqlDialect.js';
import type { SqlDialect } from '../dialect/sqlDialect.js';
import { iterNextvalRefs, rewritePgSchemaRefs, stripIdentifierSchema, stripPgSchemaRefs } from '../dialect/pgExprPort.js';
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
  /** 表级约束差异（PG：PK/UNIQUE/CHECK/FK）；不支持的方言为 undefined。 */
  constraints?: ConstraintDiff[];
  /** 索引差异（非主键索引）。 */
  indexes?: IndexDiff[];
}

/** 索引差异（主键索引不在此，由约束处理）。 */
export interface IndexDiff {
  name: string;
  status: 'added' | 'removed' | 'changed';
  columns?: string[];
  unique?: boolean;
  /** 源侧定义（PG 的 pg_get_indexdef），用于变更比较与回退生成。 */
  definition?: string;
  /** PG（4B-2a）：结构化部件——存在时 diff 按部件比较、DDL 组合生成。 */
  method?: string;
  predicate?: string;
  keyParts?: { def: string; isKey: boolean }[];
}

/** schema 级对象差异（视图/函数/触发器）。 */
export interface SchemaObjectDiff {
  name: string;
  status: 'added' | 'removed' | 'changed';
  /** 源定义（added/changed 用于生成）。 */
  definition?: string;
  /** triggers：所属表。 */
  table?: string;
  /** routines：参数签名（DROP 需要）。 */
  identityArgs?: string;
  /** routines：FUNCTION/PROCEDURE。 */
  routineType?: string;
}

/** 序列差异。 */
export interface SequenceObjectDiff {
  name: string;
  status: 'added' | 'removed' | 'changed';
  meta?: SequenceMeta;
}

/** schema 级对象集合差异。 */
export interface SchemaObjectsDiff {
  sequences: SequenceObjectDiff[];
  views: SchemaObjectDiff[];
  routines: SchemaObjectDiff[];
  triggers: SchemaObjectDiff[];
}

/** 约束差异（按约束名比对，定义由数据库规范化）。
 *  4B-2b：FK/CHECK 结构化字段存在时按结构比较/组合生成（PK/UNIQUE 保留文本路径）。 */
export interface ConstraintDiff extends ConstraintShape {
  name: string;
  type: string;
  status: 'added' | 'removed' | 'changed';
  /** 源侧定义（added/changed 时用于生成 ADD CONSTRAINT；结构化缺失时回退使用）。 */
  definition?: string;
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
    const schemas = [sourceSchema, targetSchema];
    // 约束/索引的差异与生成仅在同连接跨 schema（PG）下有意义；非 schema（如 MySQL 跨库）不参与，避免“标记变更却无 SQL”。
    const hasSchema = sourceSchema !== undefined || targetSchema !== undefined;
    const result: TableDiff[] = [];

    for (const t of sourceTables) {
      const srcCons = hasSchema && typeof sourceMeta.getConstraints === 'function' ? await sourceMeta.getConstraints(t.name, sourceSchema) : [];
      const srcIdx = hasSchema && typeof sourceMeta.getIndexes === 'function' ? await sourceMeta.getIndexes(t.name, sourceDb, sourceSchema) : [];
      const srcConsNames = new Set(srcCons.map((c) => c.name));
      // 约束（PK/UNIQUE）会自动建同名索引，避免在 diff/生成里重复处理（H5）。
      const srcIdxDiff = srcIdx.filter((i) => !i.isPrimary && !srcConsNames.has(i.name)).map((i) => ({ name: i.name, status: 'added' as const, columns: i.columns, unique: i.isUnique, definition: i.type }));
      // 源库有、目标无 → added（连同其约束/索引一并带上）
      if (!targetNames.has(t.name)) {
        result.push({
          tableName: t.name,
          status: 'added',
          columns: [],
          constraints: srcCons.map((c) => ({ name: c.name, type: c.type, status: 'added' as const, definition: c.definition })),
          indexes: srcIdxDiff,
        });
        continue;
      }
      // 都有 → 比较 columns + constraints + indexes
      const [sourceCols, targetCols] = await Promise.all([
        sourceMeta.getColumns(t.name, sourceDb, sourceSchema),
        targetMeta.getColumns(t.name, targetDb, targetSchema),
      ]);
      const colDiffs = this.diffColumns(sourceCols, targetCols, makeSchemaNormalizers(sourceSchema, targetSchema));
      const tgtCons = hasSchema && typeof targetMeta.getConstraints === 'function' ? await targetMeta.getConstraints(t.name, targetSchema) : [];
      const constraints = this.diffConstraints(srcCons, tgtCons, schemas);
      const tgtIdx = hasSchema && typeof targetMeta.getIndexes === 'function' ? await targetMeta.getIndexes(t.name, targetDb, targetSchema) : [];
      const constNames = new Set([...srcConsNames, ...tgtCons.map((c) => c.name)]);
      const indexes = this.diffIndexes(srcIdx, tgtIdx, schemas, constNames);
      result.push({
        tableName: t.name,
        status: (colDiffs.some((c) => c.status !== 'unchanged') || constraints.length > 0 || indexes.length > 0) ? 'changed' : 'unchanged',
        columns: colDiffs,
        constraints,
        indexes,
      });
    }
    // 目标有、源库无 → removed
    for (const t of targetTables) {
      if (!sourceNames.has(t.name)) {
        result.push({ tableName: t.name, status: 'removed', columns: [] });
      }
    }

    return result;
  }

  /** 按约束名比对：名缺失→added/removed，定义不同→changed（定义先做 schema 归一化）。
   *  4B-2b：FK/CHECK 双方结构化字段齐备时按结构比较（refSchema 以源/目标等价归一）；否则文本归一。 */
  private static diffConstraints(src: ConstraintMeta[], tgt: ConstraintMeta[], schemas: readonly (string | undefined)[]): ConstraintDiff[] {
    const norm = (d: string) => stripIdentifierSchema(d, schemas);
    const out: ConstraintDiff[] = [];
    const tgtMap = new Map(tgt.map((c) => [c.name, c]));
    /** 结构化字段透传到差异（生成 DDL 时优先组合生成）。 */
    const shapeOf = (c: ConstraintMeta): ConstraintShape => ({
      ...(c.columns ? { columns: [...c.columns] } : {}),
      ...(c.refSchema ? { refSchema: c.refSchema } : {}),
      ...(c.refTable ? { refTable: c.refTable } : {}),
      ...(c.refColumns ? { refColumns: [...c.refColumns] } : {}),
      ...(c.onUpdate ? { onUpdate: c.onUpdate } : {}),
      ...(c.onDelete ? { onDelete: c.onDelete } : {}),
      ...(c.match ? { match: c.match } : {}),
      ...(c.deferrable !== undefined ? { deferrable: c.deferrable } : {}),
      ...(c.initiallyDeferred !== undefined ? { initiallyDeferred: c.initiallyDeferred } : {}),
      ...(c.expression ? { expression: c.expression } : {}),
      ...(c.notValid !== undefined ? { notValid: c.notValid } : {}),
      ...(c.noInherit !== undefined ? { noInherit: c.noInherit } : {}),
    });
    /** 结构化比较；不适用（类型不符/字段缺失）返回 undefined → 回退文本。 */
    const structuredChanged = (s: ConstraintMeta, t: ConstraintMeta): boolean | undefined => {
      if (s.type === 'f' && t.type === 'f' && s.refTable && t.refTable && s.columns?.length && t.columns?.length) {
        // refSchema：源 schema 与目标 schema 视为等价（空），其它 schema 原样比较。
        const schemaKey = (c: ConstraintMeta) => (!c.refSchema || schemas.includes(c.refSchema) ? '' : c.refSchema);
        const key = (c: ConstraintMeta) => JSON.stringify([
          c.columns, c.refTable, c.refColumns ?? [], c.onUpdate ?? '', c.onDelete ?? '', c.match ?? '',
          !!c.deferrable, !!c.initiallyDeferred, schemaKey(c),
        ]);
        return key(s) !== key(t);
      }
      if (s.type === 'c' && t.type === 'c' && s.expression && t.expression) {
        return norm(String(s.expression)) !== norm(String(t.expression))
          || !!s.notValid !== !!t.notValid
          || !!s.noInherit !== !!t.noInherit;
      }
      return undefined;
    };
    for (const s of src) {
      const t = tgtMap.get(s.name);
      if (!t) {
        out.push({ name: s.name, type: s.type, status: 'added', definition: s.definition, ...shapeOf(s) });
      } else {
        const structured = structuredChanged(s, t);
        const changed = structured !== undefined ? structured : norm(s.definition) !== norm(t.definition);
        if (changed) out.push({ name: s.name, type: s.type, status: 'changed', definition: s.definition, ...shapeOf(s) });
      }
    }
    const srcNames = new Set(src.map((c) => c.name));
    for (const t of tgt) if (!srcNames.has(t.name)) out.push({ name: t.name, type: t.type, status: 'removed' });
    return out;
  }

  /** 按索引名比对（主键索引与约束同名索引跳过，由约束处理）。
   *  4B-2a：双方均有结构化部件（PG）时按部件/方法/谓词比较（表达式经 `stripIdentifierSchema` 归一）；
   *  否则回退整串定义比较（其它方言与旧路径行为不变）。 */
  private static diffIndexes(src: IndexMeta[], tgt: IndexMeta[], schemas: readonly (string | undefined)[], constraintNames: ReadonlySet<string> = new Set()): IndexDiff[] {
    const norm = (s: string) => stripIdentifierSchema(s, schemas);
    const skip = (i: IndexMeta) => i.isPrimary || constraintNames.has(i.name);
    const srcList = src.filter((i) => !skip(i));
    const tgtList = tgt.filter((i) => !skip(i));
    const tgtMap = new Map(tgtList.map((i) => [i.name, i]));
    const out: IndexDiff[] = [];
    /** 结构化字段透传到差异（生成 DDL 时优先组合生成）。 */
    const structuredOf = (i: IndexMeta): Pick<IndexDiff, 'method' | 'predicate' | 'keyParts'> => ({
      ...(i.method ? { method: i.method } : {}),
      ...(i.predicate ? { predicate: i.predicate } : {}),
      ...(i.keyParts?.length ? { keyParts: i.keyParts.map((p) => ({ def: p.def, isKey: p.isKey })) } : {}),
    });
    for (const s of srcList) {
      const t = tgtMap.get(s.name);
      const cols = (i: IndexMeta) => (i.columns ?? []).join(',');
      if (!t) {
        out.push({ name: s.name, status: 'added', columns: s.columns, unique: s.isUnique, definition: s.type, ...structuredOf(s) });
      } else {
        const bothStructured = !!(s.keyParts?.length && t.keyParts?.length);
        const changed = bothStructured
          ? !SchemaDiffService.sameIndexShape(s, t, norm)
          : norm(String(s.type ?? '')) !== norm(String(t.type ?? '')) || cols(s) !== cols(t) || !!s.isUnique !== !!t.isUnique;
        if (changed) {
          out.push({ name: s.name, status: 'changed', columns: s.columns, unique: s.isUnique, definition: s.type, ...structuredOf(s) });
        }
      }
    }
    const srcNames = new Set(srcList.map((i) => i.name));
    for (const t of tgtList) if (!srcNames.has(t.name)) out.push({ name: t.name, status: 'removed' });
    return out;
  }

  /** 结构化索引形状比较：唯一性、访问方法、谓词、部件顺序/键性与部件文本（schema 归一后）。 */
  private static sameIndexShape(a: IndexMeta, b: IndexMeta, norm: (s: string) => string): boolean {
    if (!!a.isUnique !== !!b.isUnique) return false;
    if (String(a.method ?? '') !== String(b.method ?? '')) return false;
    if (norm(String(a.predicate ?? '')) !== norm(String(b.predicate ?? ''))) return false;
    const pa = a.keyParts ?? [];
    const pb = b.keyParts ?? [];
    if (pa.length !== pb.length) return false;
    for (let i = 0; i < pa.length; i++) {
      if (!!pa[i].isKey !== !!pb[i].isKey) return false;
      if (norm(pa[i].def) !== norm(pb[i].def)) return false;
    }
    return true;
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
    opts: { sourceSchema?: string; targetSchema?: string; dialect?: SqlDialect; skipConstraints?: boolean; sourceSequences?: SequenceMeta[]; protectedNames?: ReadonlySet<string> } = {},
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
   * 4B-3：PG 表达式/类型移植的统一入口——表内 DDL 用目标方言转义，约束/schema 对象用默认转义；
   * 三处调用点（表同步/约束/schema 对象）共用同一实现，避免各写一份 `rewrite` 闭包漂移。
   */
  private static pgPorter(
    sourceSchema: string | undefined,
    targetSchema: string | undefined,
    escape: ((v: string) => string) | undefined,
    protectedNames: ReadonlySet<string> | undefined,
  ): (text: unknown) => string {
    return (text) => rewritePgSchemaRefs(toCompareString(text), sourceSchema, targetSchema, escape, protectedNames);
  }

  /**
   * 生成表级约束 DDL（PK/UNIQUE/CHECK/FK）。同步路径应在**所有表结构与数据之后**调用，
   * 避免外键引用尚未创建的表或插入时违反约束（H6）。
   */
  static generateConstraintsSql(diffs: TableDiff[], sourceTableService: TableService, opts: { sourceSchema?: string; targetSchema?: string; allowDropConstraints?: boolean; protectedNames?: ReadonlySet<string> } = {}): string {
    const wrap = (id: string) => sourceTableService.wrapIdentifier(id);
    const wrapSchema = (id: string) => sourceTableService.wrapSchemaIdentifier(id);
    const target = opts.targetSchema;
    const targetTable = (name: string): string => (target ? `${wrapSchema(target)}.${wrap(name)}` : wrap(name));
    const rewrite = SchemaDiffService.pgPorter(opts.sourceSchema, target, undefined, opts.protectedNames);
    /** 4B-2b：FK/CHECK 结构化字段齐备时组合生成（refSchema 为源/目标时映射到目标 schema）。 */
    const structuredBody = (c: ConstraintDiff): string | undefined => {
      if (c.type === 'f' && c.columns?.length && c.refTable) {
        const cols = c.columns.map((x) => wrap(validateIdent(x, 63))).join(', ');
        const refSchemaName = !c.refSchema || c.refSchema === opts.sourceSchema ? target : c.refSchema;
        const refTable = refSchemaName
          ? `${wrapSchema(validateSchemaIdent(refSchemaName))}.${wrap(validateIdent(c.refTable, 63))}`
          : wrap(validateIdent(c.refTable, 63));
        const refCols = c.refColumns?.length ? ` (${c.refColumns.map((x) => wrap(validateIdent(x, 63))).join(', ')})` : '';
        let ddl = `FOREIGN KEY (${cols}) REFERENCES ${refTable}${refCols}`;
        if (c.match && c.match !== 'SIMPLE') ddl += ` MATCH ${c.match}`;
        if (c.onDelete && c.onDelete !== 'NO ACTION') ddl += ` ON DELETE ${c.onDelete}`;
        if (c.onUpdate && c.onUpdate !== 'NO ACTION') ddl += ` ON UPDATE ${c.onUpdate}`;
        if (c.deferrable) ddl += c.initiallyDeferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE';
        return ddl;
      }
      if (c.type === 'c' && c.expression) {
        let ddl = `CHECK (${rewrite(c.expression)})`;
        if (c.noInherit) ddl += ' NO INHERIT';
        if (c.notValid) ddl += ' NOT VALID';
        return ddl;
      }
      return undefined;
    };
    const parts: string[] = [];
    const commented: string[] = [];
    for (const d of diffs) {
      if (!d.constraints?.length) continue;
      const table = targetTable(d.tableName);
      for (const c of d.constraints) {
        const cn = wrap(validateSchemaIdent(c.name, 63));
        // 破坏性 DROP 默认**只报告不执行**（避免删掉目标独有约束/被外键依赖时整批失败）；
        // 需要收敛语义时显式开启 allowDropConstraints。
        if (c.status === 'removed' && !opts.allowDropConstraints) {
          commented.push(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${cn};`);
          continue;
        }
        parts.push(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${cn};`);
        if (c.status !== 'removed') {
          parts.push(`ALTER TABLE ${table} ADD CONSTRAINT ${cn} ${structuredBody(c) ?? rewrite(c.definition ?? '')};`);
        }
      }
    }
    if (commented.length) {
      parts.push('-- 目标独有约束默认不删除（如确需删除请显式开启 allowDropConstraints）：');
      for (const line of commented) parts.push(`-- ${line}`);
    }
    return parts.join('\n');
  }

  /**
   * 对比 schema 级对象（序列/视图/函数/触发器）。非 PG 方言这些元数据为空，集合即为空。
   * 定义比对先做 schema 归一化（抹掉源/目标 schema 前缀）。
   */
  static async diffSchemaObjects(
    sourceMeta: MetadataService,
    targetMeta: MetadataService,
    sourceSchema?: string,
    targetSchema?: string,
  ): Promise<SchemaObjectsDiff> {
    const schemas = [sourceSchema, targetSchema];
    const norm = (d?: string) => stripIdentifierSchema(String(d ?? ''), schemas);
    const out: SchemaObjectsDiff = { sequences: [], views: [], routines: [], triggers: [] };

    // 序列
    const [srcSeq, tgtSeq] = await Promise.all([sourceMeta.getSequences(sourceSchema), targetMeta.getSequences(targetSchema)]);
    const tgtSeqMap = new Map(tgtSeq.map((s) => [s.name, s]));
    const seqKey = (s: SequenceMeta) => [s.dataType, s.incrementBy, s.minValue, s.maxValue, s.startValue, s.cacheSize, !!s.cycle].join('|');
    for (const s of srcSeq) {
      const t = tgtSeqMap.get(s.name);
      if (!t) out.sequences.push({ name: s.name, status: 'added', meta: s });
      else if (seqKey(s) !== seqKey(t)) out.sequences.push({ name: s.name, status: 'changed', meta: s });
    }
    const srcSeqNames = new Set(srcSeq.map((s) => s.name));
    for (const t of tgtSeq) if (!srcSeqNames.has(t.name)) out.sequences.push({ name: t.name, status: 'removed' });

    // 视图
    const [srcViews, tgtViews] = await Promise.all([sourceMeta.getViews(undefined, sourceSchema), targetMeta.getViews(undefined, targetSchema)]);
    const tgtViewMap = new Map(tgtViews.map((v) => [v.name, v]));
    for (const v of srcViews) {
      const def = await sourceMeta.getViewDefinition(v.name, undefined, sourceSchema);
      const t = tgtViewMap.get(v.name);
      if (!t) out.views.push({ name: v.name, status: 'added', definition: def });
      else if (norm(def) !== norm(await targetMeta.getViewDefinition(t.name, undefined, targetSchema))) out.views.push({ name: v.name, status: 'changed', definition: def });
    }
    const srcViewNames = new Set(srcViews.map((v) => v.name));
    for (const t of tgtViews) if (!srcViewNames.has(t.name)) out.views.push({ name: t.name, status: 'removed' });

    // 函数/例程
    const [srcRout, tgtRout] = await Promise.all([sourceMeta.getFunctions(undefined, sourceSchema), targetMeta.getFunctions(undefined, targetSchema)]);
    const routKey = (r: { name: string; identityArgs?: string }) => `${r.name}|${r.identityArgs ?? ''}`;
    const tgtRoutMap = new Map(tgtRout.map((r) => [routKey(r), r]));
    for (const r of srcRout) {
      const def = await sourceMeta.getRoutineDefinition(r.name, r.type, undefined, sourceSchema, r.identityArgs);
      const t = tgtRoutMap.get(routKey(r));
      if (!t) out.routines.push({ name: r.name, status: 'added', definition: def, identityArgs: r.identityArgs, routineType: r.type });
      else if (norm(def) !== norm(await targetMeta.getRoutineDefinition(t.name, t.type, undefined, targetSchema, t.identityArgs))) {
        out.routines.push({ name: r.name, status: 'changed', definition: def, identityArgs: r.identityArgs, routineType: r.type });
      }
    }
    const srcRoutKeys = new Set(srcRout.map(routKey));
    for (const t of tgtRout) if (!srcRoutKeys.has(routKey(t))) out.routines.push({ name: t.name, status: 'removed', identityArgs: t.identityArgs, routineType: t.type });

    // 触发器（逐表）
    const [srcTables, tgtTables] = await Promise.all([sourceMeta.getTables(undefined, sourceSchema), targetMeta.getTables(undefined, targetSchema)]);
    const tgtTrig = new Map<string, string>();
    for (const tb of tgtTables) {
      try { for (const tg of await targetMeta.getTriggers(tb.name, undefined, targetSchema)) tgtTrig.set(`${tb.name}|${tg.name}`, await targetMeta.getTriggerDefinition(tg.name, undefined, targetSchema, tb.name)); } catch { /* skip */ }
    }
    const srcTrigKeys = new Set<string>();
    for (const tb of srcTables) {
      let tris: Awaited<ReturnType<MetadataService['getTriggers']>>;
      try { tris = await sourceMeta.getTriggers(tb.name, undefined, sourceSchema); } catch { continue; }
      for (const tg of tris) {
        srcTrigKeys.add(`${tb.name}|${tg.name}`);
        const def = await sourceMeta.getTriggerDefinition(tg.name, undefined, sourceSchema, tb.name);
        const key = `${tb.name}|${tg.name}`;
        if (!tgtTrig.has(key)) out.triggers.push({ name: tg.name, status: 'added', definition: def, table: tb.name });
        else if (norm(def) !== norm(tgtTrig.get(key))) out.triggers.push({ name: tg.name, status: 'changed', definition: def, table: tb.name });
      }
    }
    for (const tb of tgtTables) {
      try { for (const tg of await targetMeta.getTriggers(tb.name, undefined, targetSchema)) if (!srcTrigKeys.has(`${tb.name}|${tg.name}`)) out.triggers.push({ name: tg.name, status: 'removed', table: tb.name }); } catch { /* skip */ }
    }

    return out;
  }

  /** 生成 schema 级对象的同步 SQL（PG 定义改写到目标 schema）。 */
  static generateSchemaObjectsSql(obj: SchemaObjectsDiff, dialect: SqlDialect, opts: { sourceSchema?: string; targetSchema?: string; protectedNames?: ReadonlySet<string> } = {}): string {
    const target = opts.targetSchema;
    const wrapObjName = (name: string) => (target ? `${dialect.wrap(validateSchemaIdent(target))}.${dialect.wrap(validateSchemaIdent(name, 63))}` : dialect.wrap(validateSchemaIdent(name, 63)));
    const rw = (d?: string) => SchemaDiffService.pgPorter(
      opts.sourceSchema,
      target,
      (v) => dialect.escapeValue(v),
      opts.protectedNames,
    )(d).replace(/;\s*$/, '');
    const parts: string[] = ['-- Schema objects', ''];

    // 序列：仅**新增**可执行（补建缺失序列）。删除/参数变更改为注释（避免破坏性 DROP 波及依赖）。
    const commented: string[] = [];
    for (const s of obj.sequences) {
      if (s.status === 'added' && dialect.createSequenceSql && s.meta) parts.push(dialect.createSequenceSql(s.name, s.meta, target));
      else if (s.status === 'removed') commented.push(`DROP SEQUENCE IF EXISTS ${wrapObjName(s.name)};`);
      else if (s.status === 'changed') commented.push(`-- 序列参数变更未处理：${s.name}`);
    }
    // 视图/函数/触发器：**只输出为注释、不在同步中执行**（依赖排序/扩展过滤/破坏性 DROP 把关尚不齐备）。
    for (const v of obj.views) {
      if (v.status === 'removed') { commented.push(`DROP VIEW IF EXISTS ${wrapObjName(v.name)};`); continue; }
      if (!v.definition) continue;
      commented.push(`DROP VIEW IF EXISTS ${wrapObjName(v.name)};`);
      commented.push(dialect.normalizeViewAlterSql(rw(v.definition), v.name, undefined, target));
    }
    for (const r of obj.routines) {
      if (r.status === 'removed') {
        const kind = /PROCEDURE/i.test(r.routineType ?? '') ? 'PROCEDURE' : 'FUNCTION';
        commented.push(`DROP ${kind} IF EXISTS ${wrapObjName(r.name)}${r.identityArgs ? `(${r.identityArgs})` : ''};`);
        continue;
      }
      if (r.definition) commented.push(rw(r.definition) + ';');
    }
    for (const t of obj.triggers) {
      if (!t.table) continue;
      commented.push(`DROP TRIGGER IF EXISTS ${dialect.wrap(validateSchemaIdent(t.name, 63))} ON ${wrapObjName(t.table)};`);
      if (t.status !== 'removed' && t.definition) commented.push(rw(t.definition) + ';');
    }
    if (commented.length) {
      parts.push('-- 以下对象未执行，需人工审阅依赖顺序后再逐一执行（逐行注释，避免函数体含 */）：');
      for (const line of commented) for (const l of line.split('\n')) parts.push(`-- ${l}`);
    }
    if (parts.length <= 2 && !commented.length) parts.push('-- No schema-object differences.');
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
    opts: { sourceSchema?: string; targetSchema?: string; dialect?: SqlDialect; skipConstraints?: boolean; sourceSequences?: SequenceMeta[]; protectedNames?: ReadonlySet<string> } = {},
  ): Promise<string> {
    const wrap = (id: string) => sourceTableService.wrapIdentifier(id);
    const wrapSchema = (id: string) => sourceTableService.wrapSchemaIdentifier(id);
    const target = opts.targetSchema;
    const targetTable = (name: string): string => (target ? `${wrapSchema(target)}.${wrap(name)}` : wrap(name));
    // #4：注释/默认值的转义必须按目标方言（scs=off 时反斜杠也要处理），不能固定用 scs=on 的实例。
    const pgEsc = opts.dialect ? (v: any): string => opts.dialect!.escapeValue(v) : PG_ESC;
    // 跨 schema：把默认表达式/类型名里的源 schema 前缀改写到目标 schema（统一经 pgPorter，4B-3）。
    const rewrite = SchemaDiffService.pgPorter(
      opts.sourceSchema,
      target,
      opts.dialect ? (v) => opts.dialect!.escapeValue(v) : undefined,
      opts.protectedNames,
    );
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
        // N2：#5 建表阶段就用**源序列元数据**生成目标序列（含参数），避免先建默认序列再被判「已存在」跳过。
        // 序列名由 schema/名称**分别 wrap** 后拼接（不把 nextval 字面量文本当标识符，防注入）。
        for (const q of new Set(extractNextvalSequences(ddl))) {
          const seqName = seqNameOf(q);
          const src = opts.sourceSequences?.find((s) => s.name === seqName);
          if (src && opts.dialect?.createSequenceSql) parts.push(opts.dialect.createSequenceSql(src.name, src, target));
          else if (target) parts.push(`CREATE SEQUENCE IF NOT EXISTS ${wrapSchema(target)}.${wrap(seqName)};`);
          else parts.push(`CREATE SEQUENCE IF NOT EXISTS ${wrap(seqName)};`);
        }
        parts.push(`DROP TABLE IF EXISTS ${table};`);
        parts.push(ddl.replace(/;\s*$/, '') + ';');
        // 把序列绑定到列（OWNED BY）：删除表/列时序列随之回收。
        for (const [q, col] of parseSequenceOwners(ddl)) {
          const seqIdent = target ? `${wrapSchema(target)}.${wrap(seqNameOf(q))}` : q;
          parts.push(`ALTER SEQUENCE ${seqIdent} OWNED BY ${table}.${wrap(col)};`);
        }
        parts.push('');
      } else if (d.status === 'removed') {
        parts.push(`-- Drop table: ${d.tableName}`);
        parts.push(`DROP TABLE IF EXISTS ${table};`);
        parts.push('');
      } else if (d.status === 'changed') {
        const actions: string[] = [];
        const warnings: string[] = [];
        const extra: string[] = [];
        // #1：给已有表新增 serial 列 / 改默认值为 nextval 时，必须**先建目标序列**（复用新增表逻辑），
        // 否则 ALTER 引用的 nextval 在目标 schema 不存在，整条语句失败。
        const pre: string[] = [];
        const post: string[] = [];
        const seqsDone = new Set<string>();
        const ensureSeq = (defaultText: unknown, ownerCol?: string): void => {
          for (const q of new Set(extractNextvalSequences(toCompareString(defaultText)))) {
            const seqName = seqNameOf(q);
            if (seqsDone.has(seqName)) continue;
            seqsDone.add(seqName);
            const src = opts.sourceSequences?.find((s) => s.name === seqName);
            if (src && opts.dialect?.createSequenceSql) pre.push(opts.dialect.createSequenceSql(src.name, src, target));
            else if (target) pre.push(`CREATE SEQUENCE IF NOT EXISTS ${wrapSchema(target)}.${wrap(seqName)};`);
            else pre.push(`CREATE SEQUENCE IF NOT EXISTS ${wrap(seqName)};`);
            // 仅新增列才建立归属；且必须等 **ADD COLUMN 之后**（列尚不存在时 OWNED BY 会报错）。
            if (ownerCol) {
              const seqIdent = target ? `${wrapSchema(target)}.${wrap(seqName)}` : wrap(seqName);
              post.push(`ALTER SEQUENCE ${seqIdent} OWNED BY ${table}.${wrap(ownerCol)};`);
            }
          }
        };
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
            ensureSeq(spec.defaultValue, c.columnName);
            // PG 在有数据的表上加 NOT NULL 且无默认值会直接失败。
            if (spec.notNull && hasNoDefault(spec) && !spec.autoIncrement) {
              actions.push(`ADD COLUMN ${col} ${renderColumnAttributes({ ...spec, notNull: false }, DatabaseType.PG, pgEsc, false, true)}`);
              warnings.push(`-- WARN: "${c.columnName}" is NOT NULL on the source but has no default; add a DEFAULT or backfill values, then enforce NOT NULL.`);
            } else {
              actions.push(`ADD COLUMN ${col} ${renderColumnAttributes(spec, DatabaseType.PG, pgEsc, false, true)}`);
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
              if (normDefault(c.sourceDefault) !== '') {
                ensureSeq(rewrite(c.sourceDefault));
                actions.push(`ALTER COLUMN ${col} SET DEFAULT ${rewrite(c.sourceDefault)}`);
              } else {
                actions.push(`ALTER COLUMN ${col} DROP DEFAULT`);
              }
            }
            // 注释是独立语句，不能并入 ALTER TABLE 子命令列表。
            if (normComment(c.sourceComment) !== normComment(c.targetComment)) {
              extra.push(`COMMENT ON COLUMN ${table}.${col} IS ${normComment(c.sourceComment) !== '' ? pgEsc(c.sourceComment) : 'NULL'};`);
            }
          }
        }
        if (actions.length || extra.length) {
          parts.push(`-- Alter table: ${d.tableName}`);
          parts.push(...pre);
          parts.push(...warnings);
          if (actions.length) parts.push(`ALTER TABLE ${table} ${actions.join(', ')};`);
          parts.push(...post);
          parts.push(...extra);
          parts.push('');
        }
      }
    }
    // 表级约束：批量生成路径在此输出；同步路径由 transferDatabase 在全部表结构+数据之后统一生成（H6）。
    if (!opts.skipConstraints) {
      const csql = this.generateConstraintsSql(diffs, sourceTableService, opts);
      if (csql) { parts.push('-- Constraints'); parts.push(csql); parts.push(''); }
    }
    // 索引：非主键；先 DROP（IF EXISTS）再建，兼容改名/定义变化。
    if (opts.dialect) {
      for (const d of diffs) {
        if (!d.indexes?.length) continue;
        const lines: string[] = [];
        for (const ix of d.indexes) {
          const dropName = target
            ? `${opts.dialect!.wrap(validateSchemaIdent(target))}.${opts.dialect!.wrap(validateSchemaIdent(ix.name, 63))}`
            : opts.dialect!.wrap(validateSchemaIdent(ix.name, 63));
          lines.push(`DROP INDEX IF EXISTS ${dropName};`);
          if (ix.status === 'removed') continue;
          // 4B-2a：有结构化部件时由方言组合生成（部件/谓词经移植层改写到目标 schema）；
          // 否则回退 H4 的 pg_get_indexdef 原文改写（保留 USING/WHERE/DESC/opclass/INCLUDE/表达式）。
          if (ix.keyParts?.length && ix.method) {
            const ixName = opts.dialect!.wrap(validateSchemaIdent(ix.name, 63));
            const keyDefs = ix.keyParts.filter((p) => p.isKey).map((p) => rewrite(p.def));
            const includeDefs = ix.keyParts.filter((p) => !p.isKey).map((p) => rewrite(p.def));
            const method = validateIdent(ix.method, 63);
            let createSql = `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ixName} ON ${targetTable(d.tableName)} USING ${method} (${keyDefs.join(', ')})`;
            if (includeDefs.length) createSql += ` INCLUDE (${includeDefs.join(', ')})`;
            if (ix.predicate) createSql += ` WHERE ${rewrite(ix.predicate)}`;
            lines.push(createSql + ';');
          } else if (ix.definition) {
            lines.push(rewrite(ix.definition).replace(/;\s*$/, '') + ';');
          }
        }
        parts.push(`-- Indexes: ${d.tableName}`);
        parts.push(...lines);
        parts.push('');
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

/** 提取 DDL 里 `nextval('<seq>'::regclass)` 的 regclass 文本（用于先生成 CREATE SEQUENCE）。 */
function extractNextvalSequences(text: string): string[] {
  return iterNextvalRefs(text).map((m) => m.ref);
}

/** 从 `nextval('<seq>'::regclass)` 的 regclass 文本取末尾标识符（去掉引号，支持名字里含 `.`）。 */
function seqNameOf(q: string): string {
  let inQuote = false;
  let cut = -1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === '"') {
      if (inQuote && q[i + 1] === '"') { i++; continue; }
      inQuote = !inQuote;
    } else if (c === '.' && !inQuote) {
      cut = i;
    }
  }
  const seg = cut >= 0 ? q.slice(cut + 1) : q;
  return seg.startsWith('"') && seg.endsWith('"') ? seg.slice(1, -1).replace(/""/g, '"') : seg;
}

/** 从建表 DDL 解析「序列 regclass 文本 → 拥有它的列」映射（列行首为列名，可能带引号或无引号）。 */
function parseSequenceOwners(ddl: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of ddl.split('\n')) {
    const colMatch = /^\s*("(?:[^"]|"")*"|\S+)/.exec(line)?.[1];
    const seq = iterNextvalRefs(line)[0]?.ref;
    if (!colMatch || !seq) continue;
    const col = colMatch.startsWith('"') ? colMatch.slice(1, -1).replace(/""/g, '"') : colMatch;
    out.set(seq, col);
  }
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

/** 字段感知的跨 schema 比较归一化器：类型/默认值按定向形态归一，注释原样。 */
function makeSchemaNormalizers(sourceSchema?: string, targetSchema?: string): ColumnNormalizers {
  if (!sourceSchema && !targetSchema) return plainNormalizers();
  const schemas = [sourceSchema, targetSchema];
  return {
    type: (v) => stripIdentifierSchema(toCompareString(v), schemas),
    // 默认值：先剥 nextval 字面量里的 schema，再剥 `::类型` 的标识符限定（enum/domain 跨 schema 等价）。
    default: (v) => normDefault(stripPgSchemaRefs(toCompareString(v), schemas)),
    comment: (v) => normComment(toCompareString(v)),
  };
}
