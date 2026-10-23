import { scanSql, splitExecutableStatements } from '@devbelt/db-core/sql';
import type { SqlScanOptions } from '@devbelt/db-core/sql';
import type { AgentEngine } from './types.js';

/**
 * Static check for SQL that the agent or an MCP client wants to run as R1.
 *
 * This is the second layer only. The boundary is the database: every call
 * runs in a read-only transaction (PG / MySQL) or on a read-only SQLite
 * session (see readOnlyRuntime.ts). The check exists to refuse obviously
 * unsafe statements before they reach the database and to block side effects
 * a read-only transaction does not stop (sleep, advisory locks, file reads,
 * notifications, cancelling other sessions).
 *
 * It fails closed: anything it cannot classify as a plain read is rejected.
 */
export type ReadOnlySqlRejectReason =
  | 'empty'
  | 'multiple_statements'
  | 'not_a_read'
  | 'explain_analyze'
  | 'forbidden_keyword'
  | 'forbidden_function'
  | 'executable_comment';

export type ReadOnlySqlCheck =
  | { ok: true; statement: string; kind: 'select' | 'explain' }
  | { ok: false; reason: ReadOnlySqlRejectReason; detail?: string };

const READ_START = /^(SELECT|WITH|VALUES|EXPLAIN)\b/;

/** Keywords that never belong in a plain read. Matched on code only, as whole words. */
const FORBIDDEN_KEYWORDS = [
  // writes and DDL
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE', 'COMMENT',
  'COPY', 'LOAD', 'IMPORT',
  // result redirection: SELECT ... INTO table/var, INTO OUTFILE/DUMPFILE
  'INTO', 'OUTFILE', 'DUMPFILE',
  // locking
  'LOCK', 'SHARE', 'NOWAIT',
  // procedures, sessions, transactions
  'CALL', 'DO', 'EXEC', 'EXECUTE', 'PREPARE', 'DEALLOCATE', 'HANDLER',
  'SET', 'RESET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'ANALYZE', 'ANALYSE', 'REINDEX', 'CLUSTER', 'OPTIMIZE',
  'LISTEN', 'UNLISTEN', 'NOTIFY', 'KILL', 'SHUTDOWN', 'FLUSH', 'PURGE', 'REFRESH',
] as const;
const FORBIDDEN_KEYWORD_RE = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b`);

/**
 * Functions with side effects outside the transaction, or that read server
 * state the model should not see. Matched as `name(` (optionally schema-
 * qualified), also when the name is quoted.
 */
const FORBIDDEN_FUNCTIONS: readonly string[] = [
  // PostgreSQL
  'nextval', 'setval', 'currval', 'lastval', 'txid_current', 'pg_current_xact_id',
  'pg_advisory_lock', 'pg_advisory_lock_shared', 'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
  'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared', 'pg_try_advisory_xact_lock', 'pg_try_advisory_xact_lock_shared',
  'pg_advisory_unlock', 'pg_advisory_unlock_shared', 'pg_advisory_unlock_all',
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_switch_wal',
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_tmpdir',
  'lo_import', 'lo_export', 'lo_create', 'lo_unlink', 'lo_open', 'lo_put', 'lo_from_bytea',
  'dblink', 'dblink_exec', 'dblink_connect', 'dblink_send_query',
  'set_config', 'current_setting', 'pg_notify',
  'query_to_xml', 'query_to_json', 'query_to_xmlschema', 'cursor_to_xml', 'table_to_xml', 'schema_to_xml', 'database_to_xml',
  'pg_create_logical_replication_slot', 'pg_create_physical_replication_slot', 'pg_drop_replication_slot',
  'pg_logical_emit_message', 'pg_logical_slot_get_changes',
  // MySQL
  'sleep', 'benchmark', 'get_lock', 'release_lock', 'release_all_locks', 'is_free_lock', 'is_used_lock',
  'load_file', 'master_pos_wait', 'source_pos_wait', 'wait_for_executed_gtid_set',
  // SQLite
  'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer',
];
const FORBIDDEN_FUNCTION_SET = new Set(FORBIDDEN_FUNCTIONS.map((f) => f.toLowerCase()));

export function scanOptionsForEngine(engine: AgentEngine): SqlScanOptions {
  return engine === 'MYSQL' ? { hashComment: true, dashDashRequiresSpace: true } : {};
}

export function checkReadOnlySql(sql: string, engine: AgentEngine): ReadOnlySqlCheck {
  const options = scanOptionsForEngine(engine);
  const statements = splitExecutableStatements(sql, options);
  if (statements.length === 0) return { ok: false, reason: 'empty' };
  if (statements.length > 1) return { ok: false, reason: 'multiple_statements', detail: String(statements.length) };
  const statement = statements[0]!;

  const segments = scanSql(statement, options);
  if (segments.some((s) => s.kind === 'execComment')) return { ok: false, reason: 'executable_comment' };

  // Code only (strings, comments and quoted identifiers blanked), upper-cased.
  const code = segments.map((s) => (s.kind === 'code' ? statement.slice(s.start, s.end) : ' ')).join('').toUpperCase();
  const head = code.trimStart();
  if (!READ_START.test(head)) return { ok: false, reason: 'not_a_read' };

  const kind: 'select' | 'explain' = head.startsWith('EXPLAIN') ? 'explain' : 'select';
  if (kind === 'explain' && /^EXPLAIN\s*(\(|ANALYZE\b|ANALYSE\b)/.test(head)) {
    // Options lists may contain ANALYZE; refuse them all rather than parse them.
    return { ok: false, reason: 'explain_analyze' };
  }
  const body = kind === 'explain' ? head.replace(/^EXPLAIN\b/, '') : head;

  const keyword = FORBIDDEN_KEYWORD_RE.exec(body);
  if (keyword) return { ok: false, reason: 'forbidden_keyword', detail: keyword[1]! };

  const fn = findForbiddenFunction(statement, segments);
  if (fn) return { ok: false, reason: 'forbidden_function', detail: fn };

  return { ok: true, statement, kind };
}

/**
 * Look for `name (` where name is a bare or quoted identifier, optionally
 * qualified (`pg_catalog.pg_sleep(`, `"pg_sleep"(`). Comments between the
 * name and the parenthesis are ignored. String literals are not names.
 */
function findForbiddenFunction(statement: string, segments: ReturnType<typeof scanSql>): string | undefined {
  // Rebuild the statement with comments removed and string literals replaced
  // by a neutral token; quoted identifiers keep their text without quotes.
  let text = '';
  for (const seg of segments) {
    const raw = statement.slice(seg.start, seg.end);
    if (seg.kind === 'comment') { text += ' '; continue; }
    if (seg.kind === 'code') { text += raw; continue; }
    if (seg.kind === 'string' && (raw.startsWith('"') || raw.startsWith('`'))) {
      text += ` ${raw.slice(1, -1).replace(/""|``/g, (m) => m[0]!)} `;
      continue;
    }
    text += " '' ";
  }
  const re = /([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1]!.toLowerCase();
    if (FORBIDDEN_FUNCTION_SET.has(name)) return name;
    if (name.startsWith('pg_advisory') || name.startsWith('pg_try_advisory') || name.startsWith('lo_') || name.startsWith('dblink')) return name;
  }
  return undefined;
}
