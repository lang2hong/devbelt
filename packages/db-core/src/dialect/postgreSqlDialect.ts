import { DatabaseType } from '../types/connection.js';
import { validateIdent, validateSchemaIdent } from '../utils/validate.js';
import { qualifyTable } from '../utils/qualify.js';
import { toBool } from '../utils/coerce.js';
import type { TableMeta, ViewMeta, RoutineMeta, EventMeta, IndexMeta, UserMeta, ForeignKeyMeta, TriggerMeta, SequenceMeta, ConstraintMeta } from '../types/meta.js';
import type { SqlDialect } from './sqlDialect.js';
import type { DatabaseCapabilities } from './capabilities.js';
import { columnTypesFor } from './typeCatalog.js';
import { buildKeysetSql } from './keyset.js';
import { escapeStringLiteralContent } from '../sql/escapeLiteral.js';

/**
 * PostgreSQL 方言实现。
 */
export class PostgreSqlDialect implements SqlDialect {
  readonly dbType = DatabaseType.PG;
  readonly columnTypes = columnTypesFor(DatabaseType.PG);

  /**
   * 本会话是否 `standard_conforming_strings=on`（PG 自 9.1 起默认 on）。
   * off 时普通 `'...'` 串里反斜杠是转义字符，值转义需翻倍反斜杠；连接层读到该 GUC 后
   * 换用本方言变体（见 DialectRegistry.getFor），默认不变。
   */
  readonly standardConformingStrings: boolean;

  constructor(opts: { standardConformingStrings?: boolean } = {}) {
    this.standardConformingStrings = opts.standardConformingStrings !== false;
  }

  createTableTemplate(table: string): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (\n  "id" SERIAL PRIMARY KEY,\n  "name" VARCHAR(255)\n);`;
  }

  addColumnTemplate(table: string): string {
    return `ALTER TABLE ${table} ADD COLUMN "new_column" INTEGER;`;
  }

  modifyColumnTemplate(table: string, column: string, definition: string): string {
    return `ALTER TABLE ${table} ALTER COLUMN ${this.wrap(column)} TYPE ${definition};`;
  }

  /** PG 无 DELIMITER 概念，函数体用 $$ 包裹并声明语言。 */
  createRoutineTemplate(name: string): string {
    return `CREATE OR REPLACE FUNCTION ${name}()\nRETURNS void AS $$\nBEGIN\n  -- function body\nEND;\n$$ LANGUAGE plpgsql;`;
  }
  readonly capabilities: DatabaseCapabilities = {
    // B2：PG 可在树里浏览该连接可见的全部库（每库懒建会话）；库下再出 schema 层。
    multiDatabaseExplorer: true,
    schemas: true,
    databases: true,
    views: true,
    routines: true,
    events: false,
    users: true,
    operations: [
      'createDatabase', 'dropDatabase', 'renameTable', 'renameView', 'truncateTable',
      // 复制表用 `CREATE TABLE ... (LIKE ... INCLUDING ALL)`；此前未声明该能力，
      // 于是「复制表」在 PG 上被一路拒到底
      'duplicateTable',
      'getTableDefinition', 'alterTable', 'manageIndexes', 'manageRoutines', 'manageUsers',
      'schemaSync',
    ],
  };

  /**
   * 包裹标识符。内部双引号必须翻倍（SQL 标准的标识符转义规则）。
   * 不翻倍时 `a","b` 会闭合标识符并让后半段脱离上下文，见 mysqlDialect.wrap 注释。
   */
  wrap(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  getPagedSql(sql: string, offset: number, limit: number): string {
    return `${sql} LIMIT ${limit} OFFSET ${offset}`;
  }

  getKeysetSql(sql: string, orderColumns: string[], afterValues: unknown[] | undefined, limit: number): string {
    return buildKeysetSql(sql, orderColumns, afterValues, limit, (c) => this.wrap(c), (v) => this.escapeValue(v));
  }

  getDatabaseListSql(): string {
    // 只列**当前用户可 CONNECT** 的非模板库：列出连不上的库会让用户点进去必然失败。
    return `SELECT datname AS name FROM pg_database
      WHERE datistemplate = false AND datallowconn = true
        AND has_database_privilege(datname, 'CONNECT')
      ORDER BY datname`;
  }

  /** PG：列出序列及其参数（同步用）。pg_sequences 视图（PG 10+）。 */
  getSequenceListSql(schema?: string): string {
    return `SELECT sequencename AS name, data_type, start_value, min_value, max_value,
        increment_by, cycle, cache_size, last_value
      FROM pg_sequences
      WHERE schemaname = ${this.schemaExpr(schema)}
      ORDER BY sequencename`;
  }

  parseSequenceList(rows: any[]): SequenceMeta[] {
    // 数值一律按字符串保留：bigint 的 max/min 超过 JS number 精度，转 Number 会丢精度。
    const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return rows.map((r) => ({
      name: String(r.name),
      dataType: r.data_type ?? undefined,
      startValue: s(r.start_value),
      minValue: s(r.min_value),
      maxValue: s(r.max_value),
      incrementBy: s(r.increment_by),
      cycle: r.cycle === true || r.cycle === 'true',
      cacheSize: s(r.cache_size),
      lastValue: s(r.last_value),
    }));
  }

  /** 生成建序列 SQL（数值按 /^-?\d+$/ 校验后原样输出，类型白名单，防注入）。 */
  createSequenceSql(name: string, seq: SequenceMeta, schema?: string): string {
    const q = this.qualified(validateIdent(name, 63), schema);
    const int = (v?: string | null): string | null => (v != null && /^-?\d+$/.test(String(v)) ? String(v) : null);
    const parts = [`CREATE SEQUENCE IF NOT EXISTS ${q}`];
    if (seq.dataType && ['bigint', 'integer', 'smallint'].includes(String(seq.dataType))) parts.push(`AS ${seq.dataType}`);
    const inc = int(seq.incrementBy); if (inc !== null) parts.push(`INCREMENT BY ${inc}`);
    const min = int(seq.minValue); if (min !== null) parts.push(`MINVALUE ${min}`);
    const max = int(seq.maxValue); if (max !== null) parts.push(`MAXVALUE ${max}`);
    const start = int(seq.startValue); if (start !== null) parts.push(`START WITH ${start}`);
    const cache = int(seq.cacheSize); if (cache !== null) parts.push(`CACHE ${cache}`);
    if (seq.cycle) parts.push('CYCLE');
    return `${parts.join(' ')};`;
  }

  /** PG：列出表级约束（PK/UNIQUE/CHECK/FK），定义由 pg_get_constraintdef 规范化。 */
  getConstraintListSql(table?: string, schema?: string): string {
    const tableFilter = table ? ` AND c.relname = ${this.escapeValue(validateIdent(table, 63))}` : '';
    return `SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid, true) AS definition, c.relname AS "table"
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = ${this.schemaExpr(schema)} AND con.contype IN ('p','u','c','f')${tableFilter}
      ORDER BY c.relname, con.conname`;
  }

  parseConstraintList(rows: any[]): ConstraintMeta[] {
    return rows.map((r) => ({ tableName: String(r.table), name: String(r.name), type: r.type as ConstraintMeta['type'], definition: String(r.definition ?? '') }));
  }

  /** PG：列出非系统、且**可操作**的 schema（树在库下展示 schema 层）。 */
  getSchemaListSql(): string {
    // `left(nspname,3) <> 'pg_'` 而非 `NOT LIKE 'pg\_%'`：后者在
    // standard_conforming_strings=off 时 `\_` 会被当转义，语义漂移。
    // schema 名一律经 `wrap`/字符串字面量安全引用（见 validateSchemaIdent），故这里
    // **不再**用字符白名单预过滤——否则含空格/`.`/`"` 的合法 schema 永远列不出来、无法操作（A6）。
    // 仅排除系统 schema 与**无 USAGE 权限**的 schema（点进去必失败）。
    return `SELECT nspname AS name FROM pg_namespace
      WHERE nspname <> 'information_schema'
        AND left(nspname, 3) <> 'pg_'
        AND has_schema_privilege(nspname, 'USAGE')
      ORDER BY nspname`;
  }

  /**
   * schema 限定：给了 schema 用字面量（validateSchemaIdent + 方言 escapeValue），否则 `current_schema()`。
   * 必须走 `escapeValue`：schema 名放宽后可能含 `\`，在 standard_conforming_strings=off 时
   * 手写「单引号翻倍」不足以阻止字符串逃逸。
   */
  private schemaExpr(schema?: string): string {
    if (!schema) return 'current_schema()';
    return this.escapeValue(validateSchemaIdent(schema, 63));
  }

  getTableListSql(_database?: string, schema?: string): string {
    return `SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ${this.schemaExpr(schema)}
      ORDER BY c.relname`;
  }

  getViewListSql(_database?: string, schema?: string): string {
    return `SELECT c.relname AS name, obj_description(c.oid) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v' AND n.nspname = ${this.schemaExpr(schema)}
      ORDER BY c.relname`;
  }

  getFunctionListSql(_database?: string, schema?: string): string {
    return `SELECT p.proname AS name,
        pg_get_function_identity_arguments(p.oid) AS identity_args,
        CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'f' THEN 'FUNCTION' ELSE 'FUNCTION' END AS type
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = ${this.schemaExpr(schema)}
      ORDER BY p.proname`;
  }

  getEventListSql(): string {
    return '';
  }

  getRoutineDefinitionSql(name: string, _routineType: string, _database?: string, schema?: string, identityArgs?: string): string {
    validateIdent(name, 63);
    // 重载函数同名：按 identity args 精确定位到某一个 oid，避免只取到第一个重载。
    const argsFilter = identityArgs !== undefined
      ? ` AND pg_get_function_identity_arguments(p.oid) = '${identityArgs.replace(/'/g, "''")}'`
      : '';
    return `SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = '${name}' AND n.nspname = ${this.schemaExpr(schema)}${argsFilter}`;
  }

  getEventDefinitionSql(): string {
    return '';
  }

  getViewDefinitionSql(name: string, _database?: string, schema?: string): string {
    validateIdent(name, 63);
    // 按 oid 取定义：旧的 `pg_get_viewdef('s' || '.' || 'V')` 把结果当**未加引号的名字**
    // 解析，含大写/`-`/空格的视图名会找不到（`"s"."publicorders"`）；按 relname+relkind
    // 过滤后传 `c.oid` 不经过名字解析。
    return `SELECT pg_get_viewdef(c.oid, true) AS definition
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = '${name}' AND c.relkind = 'v' AND n.nspname = ${this.schemaExpr(schema)}`;
  }

  /** pg_get_viewdef 返回纯 SELECT，包上 CREATE OR REPLACE VIEW 外壳。 */
  normalizeViewAlterSql(raw: string, name: string, _database?: string, schema?: string): string {
    const select = (raw || '').replace(/;?\s*$/, '').trim();
    const q = this.qualified(validateIdent(name, 63), schema);
    return `CREATE OR REPLACE VIEW ${q} AS\n${select};`;
  }

  /** PG 限定名：给了 schema 用 `"schema"."name"`，否则只包裹名字（交 search_path）。 */
  private qualified(name: string, schema?: string): string {
    return schema
      ? qualifyTable(DatabaseType.PG, this.wrap(name), undefined, this.wrap(validateSchemaIdent(schema, 63)))
      : this.wrap(name);
  }

  getIndexListSql(table: string, _database?: string, schema?: string): string {
    validateIdent(table, 63);
    // 主键判定必须用 pg_index.indisprimary，而不是猜 `<table>_pkey` 名字：
    // 自定义约束名下主键会被误判为普通唯一索引（编辑主键会生成非法 SQL）。
    return `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
      i.indisunique AS is_unique, i.indisprimary AS is_primary
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${this.schemaExpr(schema)} AND t.relname = '${table}'
      ORDER BY c.relname`;
  }

  getUserListSql(): string {
    return `SELECT usename AS name FROM pg_user ORDER BY usename`;
  }

  /** pg_user 公开但保险起见提供降级（current_user 恒可用，无 host）。 */
  getCurrentUserSql(): string {
    return `SELECT current_user AS ident`;
  }

  getForeignKeysSql(_database?: string, schema?: string): string {
    // 约束名只在单个 schema 内唯一：必须连同 `constraint_schema` 关联，否则两个 schema
    // 里的同名约束（如都叫 fk_user）会交叉错配，把外键指到别的表上。
    // 同时返回 `refSchema`（被引用表所在 schema），供跳转按真实 schema 打开。
    return `SELECT tc.table_name AS "tableName", kcu.column_name AS "columnName",
      ccu.table_name AS "refTable", ccu.column_name AS "refColumn", ccu.table_schema AS "refSchema",
      tc.constraint_name AS "constraintName"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = ${this.schemaExpr(schema)}`;
  }

  getTriggerListSql(table: string, _database?: string, schema?: string): string {
    validateIdent(table, 63);
    return `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND c.relname = '${table}' AND n.nspname = ${this.schemaExpr(schema)}`;
  }

  getTriggerDefinitionSql(name: string, _database?: string, schema?: string, table?: string): string {
    validateIdent(name, 63);
    // 触发器名只在单张表内唯一：必须带 schema + 表名过滤，否则会打开另一张表的同名触发器。
    const clauses = [`t.tgname = '${name}'`, 'NOT t.tgisinternal'];
    if (table) { validateIdent(table, 63); clauses.push(`c.relname = '${table}'`); }
    // 未传 schema 也要限定：回退 `current_schema()`（否则同名触发器会跨 schema 串到别的对象）。
    clauses.push(`n.nspname = ${this.schemaExpr(schema)}`);
    return `SELECT pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${clauses.join(' AND ')}`;
  }

  createIndexSql(name: string, table: string, columns: string[], unique: boolean, _database?: string, schema?: string): string {
    const cols = columns.map((c) => this.wrap(validateIdent(c, 63))).join(', ');
    return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.wrap(validateIdent(name, 63))} ON ${this.qualified(validateIdent(table, 63), schema)} (${cols})`;
  }

  dropIndexSql(name: string, _table?: string, _database?: string, schema?: string): string {
    // 索引与其表同命名空间：给 schema 时前缀限定，否则交 search_path。
    return `DROP INDEX IF EXISTS ${this.qualified(validateIdent(name, 63), schema)}`;
  }

  dropTriggerSql(name: string, table: string, _database?: string, schema?: string): string {
    return `DROP TRIGGER IF EXISTS ${this.wrap(validateIdent(name, 63))} ON ${this.qualified(validateIdent(table, 63), schema)}`;
  }

  createForeignKeySql(name: string, table: string, columns: string[], refTable: string, refColumns: string[], _database?: string, schema?: string, refSchema?: string): string {
    const cols = columns.map((c) => this.wrap(validateIdent(c, 63))).join(', ');
    const refCols = refColumns.map((c) => this.wrap(validateIdent(c, 63))).join(', ');
    // 被引用表可位于另一个 schema；未显式给 refSchema 时退回本表 schema（同 schema 常见情形）。
    const target = refSchema ?? schema;
    return `ALTER TABLE ${this.qualified(validateIdent(table, 63), schema)} ADD CONSTRAINT ${this.wrap(validateIdent(name, 63))} FOREIGN KEY (${cols}) REFERENCES ${this.qualified(validateIdent(refTable, 63), target)} (${refCols})`;
  }

  dropForeignKeySql(name: string, table: string, _database?: string, schema?: string): string {
    return `ALTER TABLE ${this.qualified(validateIdent(table, 63), schema)} DROP CONSTRAINT ${this.wrap(validateIdent(name, 63))}`;
  }

  getProcessListSql(): string {
    return 'SELECT pid, usename, datname, client_addr AS host, state, query FROM pg_stat_activity ORDER BY pid';
  }
  getStatusVariablesSql(): string { return ''; }
  getServerVariablesSql(): string {
    return 'SELECT name, setting, short_desc AS description FROM pg_settings ORDER BY name';
  }

  getColumnsSql(table: string, _database?: string, schema?: string): string {
    validateIdent(table, 63);
    // 主键经 table_constraints/key_column_usage 判定并输出 MySQL 风格的 key='PRI'：
    // 过去用 `'' AS key`，normalizeColumnMeta 因此对 PG 永远 isPrimary=false，
    // 使 keyset 分页在「无主键回退全列」时把可空列当游标 → `col > NULL` 恒 UNKNOWN 静默丢行。
    return `SELECT c.column_name AS name,
        c.data_type AS simple_type,
        CASE
          WHEN c.data_type IN ('character varying', 'character') AND c.character_maximum_length IS NOT NULL
            THEN c.data_type || '(' || c.character_maximum_length || ')'
          WHEN c.data_type = 'numeric' AND c.numeric_precision IS NOT NULL
            THEN c.data_type || '(' || c.numeric_precision || ',' || COALESCE(c.numeric_scale, 0) || ')'
          WHEN c.data_type = 'USER-DEFINED' AND c.udt_name IS NOT NULL
            THEN c.udt_name
          ELSE c.data_type
        END AS type,
        COALESCE(c.column_default, '') AS default_value,
        c.is_nullable AS nullable,
        '' AS comment,
        CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_name = '${table}'
           AND tc.table_schema = ${this.schemaExpr(schema)}
      ) pk ON pk.column_name = c.column_name
      WHERE c.table_name = '${table}' AND c.table_schema = ${this.schemaExpr(schema)}
      ORDER BY c.ordinal_position`;
  }

  parseTableList(rows: any[]): TableMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseViewList(rows: any[]): ViewMeta[] {
    return rows.map((row) => ({ name: row.name, comment: row.comment || '' }));
  }

  parseFunctionList(rows: any[]): RoutineMeta[] {
    return rows.map((row) => ({
      name: row.name,
      type: row.type || 'FUNCTION',
      comment: '',
      identityArgs: row.identity_args ?? undefined,
    }));
  }

  parseEventList(): EventMeta[] {
    return [];
  }

  /**
   * 解析索引列表。列名从 `pg_get_indexdef` 的定义串中提取——PG 的
   * `pg_indexes` 不直接给列清单，此前返回空数组导致索引编辑弹窗勾选项全空。
   */
  parseIndexList(rows: any[]): IndexMeta[] {
    return rows.map((row) => ({
      name: row.name,
      columns: parseIndexDefColumns(row.definition),
      isUnique: toBool(row.is_unique) || /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(String(row.definition ?? '')),
      isPrimary: toBool(row.is_primary),
      type: row.definition || '',
    }));
  }

  parseTriggerList(rows: any[]): TriggerMeta[] {
    return rows.map((row) => {
      const def: string = row.definition || '';
      const timing = (def.match(/\b(BEFORE|AFTER|INSTEAD OF)\b/i) || [])[1]?.toUpperCase();
      const event = (def.match(/\b(INSERT|UPDATE|DELETE)\b/i) || [])[1]?.toUpperCase();
      return { name: row.name, timing, event };
    });
  }

  parseUserList(rows: any[]): UserMeta[] {
    return rows.map((row) => ({ name: row.name }));
  }

  parseForeignKeys(rows: any[]): ForeignKeyMeta[] {
    return rows.map((row) => ({
      tableName: row.tableName || row.tablename,
      columnName: row.columnName || row.column_name,
      refTable: row.refTable || row.reftable,
      refColumn: row.refColumn || row.refcolumn,
      refSchema: row.refSchema || row.refschema || undefined,
      constraintName: row.constraintName || row.constraint_name,
    }));
  }

  buildInsertSql(rows: Record<string, any>[], columns: string[], table: string, _database?: string, schema?: string): string {
    const validTable = validateIdent(table, 63);
    const qualified = this.qualified(validTable, schema);
    const colList = columns.map((c) => this.wrap(validateIdent(c, 63))).join(', ');
    let out = '';
    for (const row of rows) {
      const values = columns.map((c) => this.escapeValue(row[c])).join(', ');
      out += `INSERT INTO ${qualified} (${colList}) VALUES (${values});\n`;
    }
    return out;
  }

  /** PostgreSQL 标准字符串：仅单引号翻倍；standard_conforming_strings=off 时反斜杠也需翻倍。 */
  escapeValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    const backslashEscapes = !this.standardConformingStrings;
    if (value instanceof Date) return `'${escapeStringLiteralContent(value.toISOString(), backslashEscapes)}'`;
    if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'`;
    if (typeof value === 'object') {
      return `'${escapeStringLiteralContent(JSON.stringify(value), backslashEscapes)}'`;
    }
    return `'${escapeStringLiteralContent(String(value), backslashEscapes)}'`;
  }
}

/**
 * 从 `CREATE [UNIQUE] INDEX name ON tbl USING btree (a, b DESC, lower(c))`
 * 中提取列名列表。
 *
 * 只取最外层括号内以逗号分隔的项，去掉排序/NULLS/操作符类修饰与引号；
 * 表达式索引（如 `lower(c)`）原样保留，便于 UI 展示。
 */
function parseIndexDefColumns(definition: unknown): string[] {
  const def = String(definition ?? '');
  const start = def.indexOf('(');
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < def.length; i++) {
    if (def[i] === '(') depth++;
    else if (def[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return [];

  const parts: string[] = [];
  let buf = '';
  let nested = 0;
  for (const ch of def.slice(start + 1, end)) {
    if (ch === '(') nested++;
    else if (ch === ')') nested--;
    if (ch === ',' && nested === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);

  return parts
    .map((part) => part
      .trim()
      .replace(/\s+(ASC|DESC)\b/i, '')
      .replace(/\s+NULLS\s+(FIRST|LAST)\b/i, '')
      .replace(/\s+COLLATE\s+\S+/i, '')
      .replace(/\s+\S*_ops\b/i, '')
      .trim()
      .replace(/^"(.*)"$/, '$1'))
    .filter((part) => part.length > 0);
}
