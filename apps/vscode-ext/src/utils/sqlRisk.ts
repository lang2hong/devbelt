import { scanSql, sqlSkeleton, type SqlScanOptions } from '@devkit/db-core/sql';

export type SqlRiskLevel = 'none' | 'write' | 'critical';

export interface SqlRisk {
  level: SqlRiskLevel;
  isWrite: boolean;
  reason?: string;
}

const DDL_RE = /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/;
const DML_RE = /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/;
const UPDATE_OR_DELETE_RE = /\b(UPDATE|DELETE)\b/;
const WHERE_RE = /\bWHERE\b/;
/**
 * 过程/动态执行控制语句：其真正执行的内容可能在 dollar 引用体里（被骨架空白化），
 * 无法静态判定，一律按 critical 处理（fail-closed）。
 */
const PROCEDURAL_RE = /\b(DO|CALL|EXECUTE)\b/;
/**
 * 服务端文件写出/批量装载：`SELECT … INTO OUTFILE/DUMPFILE`、`COPY … FROM/TO`、
 * `LOAD DATA INFILE`。可能读写 DB 主机文件或整表装载，按 critical 处理。
 */
const SERVER_FILE_RE = /\bINTO\s+(OUTFILE|DUMPFILE)\b/;
const COPY_RE = /\bCOPY\b/;
const LOAD_RE = /\bLOAD\b/;
/** 维护/全局设置类写动作：`VACUUM`/`REINDEX`、`SET GLOBAL`。 */
const MAINTENANCE_RE = /\b(VACUUM|REINDEX)\b/;
const GLOBAL_SET_RE = /\bSET\s+GLOBAL\b/;

/**
 * 写语句动作类型，供结果面板区分「影响行数」与「成功」两类展示：
 * DML（INSERT/UPDATE/DELETE/REPLACE/MERGE）有受影响行数的语义；
 * DDL（CREATE/ALTER/DROP/TRUNCATE/RENAME/GRANT/REVOKE）与其余控制语句没有，
 * 展示「成功」而非误导性的「0 行受影响」。
 */
export function classifyWriteKind(sql: string, options?: SqlScanOptions): 'dml' | 'ddl' | 'other' {
  const normalized = sqlSkeleton(sql, options).trim().toUpperCase();
  if (DDL_RE.test(normalized)) return 'ddl';
  if (DML_RE.test(normalized)) return 'dml';
  return 'other';
}

/**
 * 保守、零依赖的风险分类器，供所有执行面共用。
 *
 * 对**语法骨架**做关键字匹配，并按分号逐条判定；此外对两类「骨架看不到内容」
 * 的输入 fail-closed：
 *  - 过程/动态执行控制语句（`DO` / `CALL` / `EXECUTE`）——真正执行体可能在
 *    dollar 引用里被空白化，如 `DO $$ BEGIN DELETE FROM users; END $$`；
 *  - 含美元引用体（`$$…$$` / `$tag$…$tag$`）的语句——内容不可静态判定。
 * 二者都会让 `confirmSqlExecution` 认定 isWrite 从而施加只读/生产确认，
 * 避免旧实现（不识别 `$` 时 DELETE 可见会被拦）被回归绕过。
 *
 * 边界：这是**正向关键字匹配**，不可能穷尽所有写路径（自定义函数副作用、
 * 未被列出的方言语句等）。真实安全边界是连接所用 DB 账号的 ACL；本分类器
 * 只用于对只读/生产连接追加确认，不宣称是完备的写检测。
 */
export function analyzeSqlRisk(sql: string, options?: SqlScanOptions): SqlRisk {
  const segments = scanSql(sql, options);
  const skeleton = sqlSkeleton(sql, options);
  const opaqueBody = segments.some((s) => s.kind === 'dollar');

  if (!skeleton.trim()) {
    return opaqueBody
      ? { level: 'write', isWrite: true, reason: 'opaque dollar-quoted body' }
      : { level: 'none', isWrite: false };
  }

  let hasWrite = false;
  for (const rawStmt of skeleton.split(';')) {
    const stmt = rawStmt.trim().toUpperCase();
    if (!stmt) continue;

    if (DDL_RE.test(stmt)) {
      return { level: 'critical', isWrite: true, reason: 'DDL or permission change' };
    }
    if (PROCEDURAL_RE.test(stmt)) {
      return { level: 'critical', isWrite: true, reason: 'procedural or dynamic execution' };
    }
    if (SERVER_FILE_RE.test(stmt) || COPY_RE.test(stmt) || LOAD_RE.test(stmt)) {
      return { level: 'critical', isWrite: true, reason: 'server-side file or bulk load' };
    }
    if (MAINTENANCE_RE.test(stmt) || GLOBAL_SET_RE.test(stmt)) hasWrite = true;
    if (DML_RE.test(stmt)) hasWrite = true;
    if (UPDATE_OR_DELETE_RE.test(stmt) && !WHERE_RE.test(stmt)) {
      return { level: 'critical', isWrite: true, reason: 'UPDATE or DELETE without WHERE' };
    }
  }

  if (opaqueBody) return { level: 'write', isWrite: true, reason: 'opaque dollar-quoted body' };
  return hasWrite ? { level: 'write', isWrite: true } : { level: 'none', isWrite: false };
}
