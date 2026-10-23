/**
 * Conservative column-usage extraction for index advice.
 *
 * This is a heuristic, not a SQL parser: it recognises only simple
 * `[alias.]col <op> value`, `col IN (...)`, `col BETWEEN`, `col LIKE 'x%'`,
 * `a.x = b.y` joins and `ORDER BY` / `GROUP BY` column lists. Anything it does
 * not understand (functions around columns, OR, sub-queries, expressions) is
 * skipped so the advisor never builds on a guess.
 */

export type PredicateKind = 'eq' | 'range' | 'join' | 'order' | 'group';

export interface ColumnPredicate {
  /** Real table name (aliases resolved); lower-cased. */
  table: string;
  /** Column name; lower-cased. */
  column: string;
  kind: PredicateKind;
}

export interface PredicateExtraction {
  /** Real table names referenced in FROM/JOIN; lower-cased. */
  tables: string[];
  predicates: ColumnPredicate[];
  /** True when OR was found in WHERE: equality advice for that clause is unreliable. */
  hasOr: boolean;
  /**
   * Alias (and table name) → real table name, lower-cased. MySQL and SQLite
   * report aliases in their plans, so plan node names must be mapped through
   * this before they can be matched against `tables`.
   */
  aliases: Record<string, string>;
}

/** Map a plan node object name (possibly an alias) to the real table name. */
export function resolvePlanTable(name: string, aliases: Record<string, string>): string {
  const key = unquote(name);
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
}

const IDENT = String.raw`[A-Za-z_][\w$]*`;
const QUOTED = String.raw`(?:` + '`[^`]+`' + String.raw`|"[^"]+"|\[[^\]]+\]|${IDENT})`;
const COLUMN_REF = String.raw`(?:(${QUOTED})\s*\.\s*)?(${QUOTED})`;

const CLAUSE_END = /\b(WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|UNION|FETCH|FOR\s+UPDATE|WINDOW)\b/i;
const RESERVED = new Set([
  'on', 'using', 'where', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural',
  'group', 'order', 'limit', 'having', 'as', 'set', 'values', 'select', 'lateral', 'straight_join',
]);

function unquote(name: string): string {
  return name.replace(/^[`"[]|[`"\]]$/g, '').toLowerCase();
}

/** Blank out string literals and comments so keywords inside them are not matched. */
function maskLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    // Keep a leading LIKE wildcard so `'%x'` is still recognisably non-sargable.
    .replace(/'(?:[^'\\]|\\.|'')*'/g, (m) => {
      const body = m.slice(1, -1);
      const lead = body.startsWith('%') || body.startsWith('_') ? '%' : '';
      return `'${lead}${'x'.repeat(Math.max(0, body.length - lead.length))}'`;
    });
}

/** Text between `keyword` and the next top-level clause keyword. */
function clauseBody(sql: string, keyword: RegExp): string | undefined {
  const match = keyword.exec(sql);
  if (!match) return undefined;
  const rest = sql.slice(match.index + match[0].length);
  const end = rest.search(CLAUSE_END);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Drop parenthesised groups that contain SELECT (sub-queries). */
function stripSubqueries(text: string): string {
  let out = text;
  for (let i = 0; i < 10; i++) {
    // Keep the parentheses so `col IN (subquery)` still reads as an IN predicate.
    const next = out.replace(/\((?:[^()]*)\bSELECT\b(?:[^()]*)\)/gi, '(?)');
    if (next === out) break;
    out = next;
  }
  return out;
}

function resolveTables(fromBody: string): { tables: string[]; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const explicit = new Set<string>();
  const tables: string[] = [];
  // The alias must not swallow the next JOIN keyword, or the joined table is missed.
  const notKeyword = String.raw`(?!(?:ON|USING|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|NATURAL|STRAIGHT_JOIN|GROUP|ORDER|LIMIT|SET)\b)`;
  const source = new RegExp(
    String.raw`(?:^|,|\bJOIN\b)\s*(?:(${QUOTED})\s*\.\s*)?(${QUOTED})(?:\s+(?:AS\s+)?${notKeyword}(${QUOTED}))?`,
    'gi',
  );
  for (const m of fromBody.matchAll(source)) {
    const table = unquote(m[2]);
    if (RESERVED.has(table)) continue;
    tables.push(table);
    const alias = m[3] ? unquote(m[3]) : undefined;
    // An explicit alias wins over a bare table name: in `FROM a b JOIN b c`,
    // `b` refers to table a, and the plan reports `b` / `c`.
    if (alias && !RESERVED.has(alias)) {
      aliases.set(alias, table);
      explicit.add(alias);
    }
    if (!explicit.has(table)) aliases.set(table, table);
  }
  return { tables: [...new Set(tables)], aliases };
}

function resolveColumn(
  qualifier: string | undefined,
  column: string,
  aliases: Map<string, string>,
  tables: string[],
): { table: string; column: string } | undefined {
  const col = unquote(column);
  if (qualifier) {
    const table = aliases.get(unquote(qualifier));
    return table ? { table, column: col } : undefined;
  }
  // Unqualified columns are only attributable when exactly one table is in scope.
  return tables.length === 1 ? { table: tables[0], column: col } : undefined;
}

function pushUnique(list: ColumnPredicate[], item: ColumnPredicate): void {
  if (!list.some((p) => p.table === item.table && p.column === item.column && p.kind === item.kind)) {
    list.push(item);
  }
}

/** Split a boolean expression on top-level AND (parentheses respected). */
function splitAnd(expr: string): string[] {
  // `BETWEEN a AND b`: that AND belongs to BETWEEN, not to the boolean chain.
  const text = expr.replace(/\bBETWEEN\s+(\S+)\s+AND\s+/gi, 'BETWEEN $1 \u0000 ');
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      const m = /^\s+AND\s+/i.exec(text.slice(i));
      if (m) {
        parts.push(text.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.replace(/\u0000/g, 'AND').trim()).filter(Boolean);
}

function classifyCondition(
  cond: string,
  aliases: Map<string, string>,
  tables: string[],
  out: ColumnPredicate[],
  joinContext: boolean,
): void {
  const text = cond.replace(/^\(+|\)+$/g, '').trim();
  const join = new RegExp(String.raw`^${COLUMN_REF}\s*=\s*${COLUMN_REF}$`, 'i').exec(text);
  if (join) {
    const left = resolveColumn(join[1], join[2], aliases, tables);
    const right = resolveColumn(join[3], join[4], aliases, tables);
    if (left && right && left.table !== right.table) {
      pushUnique(out, { ...left, kind: 'join' });
      pushUnique(out, { ...right, kind: 'join' });
    }
    return;
  }
  if (joinContext) return;

  const eq = new RegExp(String.raw`^${COLUMN_REF}\s*(?:=|<=>|\bIS\s+NULL\b|\bIN\s*\()`, 'i').exec(text);
  if (eq && !new RegExp(String.raw`^${COLUMN_REF}\s*=\s*${COLUMN_REF}`, 'i').test(text)) {
    const ref = resolveColumn(eq[1], eq[2], aliases, tables);
    if (ref) pushUnique(out, { ...ref, kind: 'eq' });
    return;
  }
  const range = new RegExp(String.raw`^${COLUMN_REF}\s*(?:<=|>=|<>|!=|<|>|\bBETWEEN\b|\bLIKE\s+'[^%_']+%?')`, 'i').exec(text);
  if (range) {
    // `<>` / `!=` and leading-wildcard LIKE cannot use an index range; skip them.
    if (/(<>|!=)/.test(text.slice(range[0].length - 2, range[0].length))) return;
    const ref = resolveColumn(range[1], range[2], aliases, tables);
    if (ref) pushUnique(out, { ...ref, kind: 'range' });
  }
}

function columnList(
  body: string | undefined,
  kind: 'order' | 'group',
  aliases: Map<string, string>,
  tables: string[],
  out: ColumnPredicate[],
): void {
  if (!body) return;
  for (const raw of body.split(',')) {
    const item = raw.trim().replace(/\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?$/i, '').trim();
    const m = new RegExp(String.raw`^${COLUMN_REF}$`, 'i').exec(item);
    if (!m) return; // expressions/positions: stop, later columns would be misleading
    const ref = resolveColumn(m[1], m[2], aliases, tables);
    if (!ref) return;
    pushUnique(out, { ...ref, kind });
  }
}

export function extractPredicates(sql: string): PredicateExtraction {
  const masked = stripSubqueries(maskLiterals(sql));
  const fromBody = clauseBody(masked, /\bFROM\b/i) ?? clauseBody(masked, /\bUPDATE\b/i) ?? '';
  const sources = fromBody.replace(/\bON\b[\s\S]*?(?=\bJOIN\b|,|$)/gi, ' ').replace(/\bUSING\s*\([^)]*\)/gi, ' ');
  const { tables, aliases } = resolveTables(sources);
  const predicates: ColumnPredicate[] = [];

  for (const m of fromBody.matchAll(/\bON\b([\s\S]*?)(?=\b(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL)?\s*(?:OUTER\s+)?JOIN\b|$)/gi)) {
    for (const cond of splitAnd(m[1])) classifyCondition(cond, aliases, tables, predicates, true);
  }

  const where = clauseBody(masked, /\bWHERE\b/i);
  const hasOr = !!where && /\bOR\b/i.test(where);
  if (where && !hasOr) {
    for (const cond of splitAnd(where)) classifyCondition(cond, aliases, tables, predicates, false);
  }

  columnList(clauseBody(masked, /\bGROUP\s+BY\b/i), 'group', aliases, tables, predicates);
  columnList(clauseBody(masked, /\bORDER\s+BY\b/i), 'order', aliases, tables, predicates);

  return { tables, predicates, hasOr, aliases: Object.fromEntries(aliases) };
}