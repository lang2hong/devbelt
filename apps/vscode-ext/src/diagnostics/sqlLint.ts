import { DatabaseType } from '@devbelt/db-core';
import { scanSql, splitSqlWithRanges, type SqlScanOptions } from '@devbelt/db-core/sql';

export type LintSeverity = 'error' | 'warning' | 'info' | 'hint';
export type LintRuleSetting = LintSeverity | 'off';

export type LintRuleId =
  | 'updateDeleteWithoutWhere'
  | 'dangerousDdl'
  | 'notInSubquery'
  | 'selectStar'
  | 'dialectMismatch';

export const LINT_RULE_IDS: readonly LintRuleId[] = [
  'updateDeleteWithoutWhere',
  'dangerousDdl',
  'notInSubquery',
  'selectStar',
  'dialectMismatch',
];

export interface LintFinding {
  rule: LintRuleId;
  severity: LintSeverity;
  /** Offset of the first flagged character in the document. */
  start: number;
  /** Offset after the last flagged character. */
  end: number;
  /** i18n key of the message. */
  messageKey: string;
  args?: Record<string, string>;
}

export interface LintOptions {
  /** Only set when the document is bound to a connection; enables dialect rules. */
  dbType?: DatabaseType;
  scanOptions?: SqlScanOptions;
  /** Per-rule overrides; unknown/invalid values fall back to the rule default. */
  rules?: Partial<Record<string, unknown>>;
}

const SETTINGS = new Set<LintRuleSetting>(['off', 'error', 'warning', 'info', 'hint']);

/**
 * Same-length mask: strings, comments and dollar bodies become spaces (newlines
 * kept) so regex offsets on the result map 1:1 onto the original text.
 * Executable comments (`/*! … *\/`) stay visible because MySQL runs them.
 */
export function maskSql(sql: string, options: SqlScanOptions = {}): string {
  let out = '';
  for (const seg of scanSql(sql, options)) {
    const text = sql.slice(seg.start, seg.end);
    out += seg.kind === 'code' || seg.kind === 'execComment' ? text : text.replace(/[^\n]/g, ' ');
  }
  return out;
}

function resolveSeverity(rule: LintRuleId, fallback: LintSeverity, rules: LintOptions['rules']): LintSeverity | undefined {
  const value = rules?.[rule];
  if (typeof value === 'string' && SETTINGS.has(value as LintRuleSetting)) {
    return value === 'off' ? undefined : (value as LintSeverity);
  }
  return fallback;
}

/** Index of the matching `)` for the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Replace every parenthesised group with spaces (same length), leaving the top level. */
function topLevel(text: string): string {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') { depth++; out += ' '; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); out += ' '; continue; }
    out += depth > 0 && ch !== '\n' ? ' ' : ch;
  }
  return out;
}

type Emit = (rule: LintRuleId, fallback: LintSeverity, start: number, end: number, messageKey: string, args?: Record<string, string>) => void;

function lintStatement(masked: string, base: number, dbType: DatabaseType | undefined, emit: Emit): void {
  const top = topLevel(masked);
  const lead = /^\s*/.exec(top)?.[0].length ?? 0;
  const head = top.slice(lead);

  // UPDATE / DELETE without WHERE (top-level only; WITH … UPDATE is covered by the search).
  const write = /\b(UPDATE|DELETE)\b/i.exec(head);
  if (write && /^(WITH\b|UPDATE\b|DELETE\b)/i.test(head) && !/\bWHERE\b/i.test(head.slice(write.index))) {
    const at = lead + write.index;
    emit('updateDeleteWithoutWhere', 'warning', base + at, base + at + write[0].length, 'diag.sql.noWhere', { verb: write[1].toUpperCase() });
  }

  // DROP / TRUNCATE (warning) and ALTER (info), only as the statement's own verb.
  const ddl = /^(DROP|TRUNCATE|ALTER)\b/i.exec(head);
  if (ddl) {
    const verb = ddl[1].toUpperCase();
    emit(
      'dangerousDdl',
      verb === 'ALTER' ? 'info' : 'warning',
      base + lead,
      base + lead + ddl[0].length,
      verb === 'ALTER' ? 'diag.sql.alter' : 'diag.sql.destructiveDdl',
      { verb },
    );
  }

  // NOT IN (SELECT …): a single NULL from the sub-query makes the predicate never true.
  for (const m of masked.matchAll(/\bNOT\s+IN\s*\(\s*SELECT\b/gi)) {
    const at = m.index ?? 0;
    const open = masked.indexOf('(', at);
    const close = matchParen(masked, open);
    emit('notInSubquery', 'warning', base + at, base + (close === -1 ? at + m[0].length : close + 1), 'diag.sql.notInSubquery');
  }

  // Outermost SELECT * (not COUNT(*), not t.*).
  const star = /^(?:WITH\b[\s\S]*?)?\bSELECT\s+(?:ALL\s+|DISTINCT\s+)?(\*)/i.exec(head);
  if (star && /^(SELECT|WITH)\b/i.test(head)) {
    const at = lead + star.index + star[0].length - 1;
    emit('selectStar', 'hint', base + at, base + at + 1, 'diag.sql.selectStar');
  }

  // Dialect checks only when the connection is known.
  if (dbType === DatabaseType.PG) {
    // Backtick identifiers are lexed as quoted segments; they are reported from the scan in lintSql.
    for (const m of top.matchAll(/\bLIMIT\s+\d+\s*,\s*\d+/gi)) {
      emit('dialectMismatch', 'warning', base + (m.index ?? 0), base + (m.index ?? 0) + m[0].length, 'diag.sql.pgLimitComma');
    }
  } else if (dbType === DatabaseType.MYSQL) {
    for (const m of masked.matchAll(/\bILIKE\b/gi)) {
      emit('dialectMismatch', 'warning', base + (m.index ?? 0), base + (m.index ?? 0) + m[0].length, 'diag.sql.mysqlIlike');
    }
    for (const m of masked.matchAll(/::\s*[A-Za-z_]\w*/g)) {
      emit('dialectMismatch', 'warning', base + (m.index ?? 0), base + (m.index ?? 0) + m[0].length, 'diag.sql.mysqlCast');
    }
  }
}

/**
 * Static SQL lint (P10 S7). Pure: no database access, no vscode dependency.
 *
 * Each statement is checked on a same-length mask, so findings never point
 * into strings or comments and their offsets map straight back to the source.
 */
export function lintSql(text: string, options: LintOptions = {}): LintFinding[] {
  const scan = options.scanOptions ?? {};
  const masked = maskSql(text, scan);
  const findings: LintFinding[] = [];
  const emit: Emit = (rule, fallback, start, end, messageKey, args) => {
    const severity = resolveSeverity(rule, fallback, options.rules);
    if (!severity) return;
    findings.push({ rule, severity, start, end, messageKey, ...(args ? { args } : {}) });
  };
  for (const stmt of splitSqlWithRanges(text, scan)) {
    lintStatement(masked.slice(stmt.start, stmt.end), stmt.start, options.dbType, emit);
  }
  if (options.dbType === DatabaseType.PG) {
    // The scanner treats `x` as a quoted segment, so it is invisible in the mask.
    for (const seg of scanSql(text, scan)) {
      if (seg.kind === 'string' && text[seg.start] === '`') {
        emit('dialectMismatch', 'warning', seg.start, seg.end, 'diag.sql.pgBacktick');
      }
    }
    findings.sort((a, b) => a.start - b.start);
  }
  return findings;
}