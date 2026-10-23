import { resolvePlanTable, type ColumnPredicate, type PredicateExtraction } from './predicates.js';
import type { ExplainPlan, ExplainPlanNode } from './types.js';

export interface AdvisorColumn {
  name: string;
  /** Declared type, e.g. `tinyint(1)`, `boolean`, `varchar(255)`. */
  type?: string;
  isPrimary?: boolean;
  isUnique?: boolean;
}

export interface AdvisorIndex {
  name: string;
  columns: string[];
  isPrimary?: boolean;
  isUnique?: boolean;
}

export interface AdvisorTable {
  name: string;
  columns: AdvisorColumn[];
  indexes: AdvisorIndex[];
}

export type SuggestionConfidence = 'high' | 'medium' | 'low';

/** i18n-friendly reason/risk codes; the UI renders the text. */
export type SuggestionReason =
  | 'fullScanWithFilter'
  | 'filesort'
  | 'joinColumn'
  | 'equalityFirst'
  | 'rangeAfterEquality'
  | 'orderAfterEquality';

export type SuggestionRisk =
  | 'writeAmplification'
  | 'lockOnBuild'
  | 'selectivityUnknown'
  | 'lowCardinality';

export interface IndexSuggestion {
  table: string;
  columns: string[];
  confidence: SuggestionConfidence;
  reasons: SuggestionReason[];
  risks: SuggestionRisk[];
}

export interface RedundantIndex {
  table: string;
  /** Index whose columns are a prefix of `coveredBy`. */
  index: string;
  coveredBy: string;
}

export interface IndexAdvice {
  suggestions: IndexSuggestion[];
  redundant: RedundantIndex[];
}

export interface IndexAdvisorInput {
  plan: ExplainPlan;
  extraction: PredicateExtraction;
  tables: AdvisorTable[];
  /** Max columns per suggested index. */
  maxColumns?: number;
  /** Max suggestions per table. */
  maxPerTable?: number;
}

const LOW_CARDINALITY_TYPE = /^(bool|boolean|bit(\(1\))?|tinyint\(1\))$/i;

interface TableSignal {
  fullScan: boolean;
  filesort: boolean;
}

function lower(name: string): string {
  return name.toLowerCase();
}

/**
 * Tables the plan flags as needing help, keyed by lower-cased real table name.
 * Plan node names may be aliases (MySQL/SQLite), so they go through `aliases`.
 */
function planSignals(plan: ExplainPlan, aliases: Record<string, string>): Map<string, TableSignal> {
  const signals = new Map<string, TableSignal>();
  let planFilesort = false;
  const walk = (nodes: readonly ExplainPlanNode[]): void => {
    for (const node of nodes) {
      if (node.warnings.includes('filesort')) planFilesort = true;
      if (node.object && (node.warnings.includes('fullTableScan') || node.warnings.includes('filesort'))) {
        const key = resolvePlanTable(node.object, aliases);
        const s = signals.get(key) ?? { fullScan: false, filesort: false };
        if (node.warnings.includes('fullTableScan')) s.fullScan = true;
        if (node.warnings.includes('filesort')) s.filesort = true;
        signals.set(key, s);
      }
      walk(node.children);
    }
  };
  walk(plan.roots);
  // Sort nodes usually carry no table; attribute plan-level filesort to every flagged table.
  if (planFilesort) for (const s of signals.values()) s.filesort = true;
  return signals;
}

/** True when an existing index already starts with `columns` (same order). */
function coveredByExisting(columns: string[], indexes: AdvisorIndex[]): boolean {
  return indexes.some((idx) => {
    const cols = idx.columns.map(lower);
    return columns.every((c, i) => cols[i] === c);
  });
}

function findRedundant(table: AdvisorTable): RedundantIndex[] {
  const out: RedundantIndex[] = [];
  for (const a of table.indexes) {
    if (a.isPrimary || a.isUnique || a.columns.length === 0) continue;
    const aCols = a.columns.map(lower);
    const wider = table.indexes.find((b) => {
      if (b === a || b.columns.length < aCols.length) return false;
      const bCols = b.columns.map(lower);
      if (b.columns.length === aCols.length && b.name.localeCompare(a.name) >= 0) return false;
      return aCols.every((c, i) => bCols[i] === c);
    });
    if (wider) out.push({ table: table.name, index: a.name, coveredBy: wider.name });
  }
  return out;
}

function buildCandidate(
  preds: ColumnPredicate[],
  columns: Map<string, AdvisorColumn>,
  signal: TableSignal,
  maxColumns: number,
): IndexSuggestion | undefined {
  const usable = (p: ColumnPredicate): boolean => {
    const col = columns.get(p.column);
    return !!col && !col.isPrimary && !col.isUnique;
  };
  const eq = preds.filter((p) => (p.kind === 'eq' || p.kind === 'join') && usable(p)).map((p) => p.column);
  const range = preds.filter((p) => p.kind === 'range' && usable(p)).map((p) => p.column);
  const order = preds.filter((p) => (p.kind === 'order' || p.kind === 'group') && usable(p)).map((p) => p.column);

  const picked: string[] = [];
  const add = (c: string): void => { if (!picked.includes(c) && picked.length < maxColumns) picked.push(c); };
  eq.forEach(add);
  // A range column ends the usable prefix; ORDER BY can only follow pure equality.
  const firstRange = range.find((c) => !picked.includes(c));
  if (firstRange) add(firstRange);
  else if (signal.filesort) order.forEach(add);
  if (picked.length === 0) return undefined;

  const whereEq = preds.some((p) => p.kind === 'eq' && picked.includes(p.column));
  const reasons: SuggestionReason[] = [];
  if (signal.fullScan && (whereEq || !!firstRange)) reasons.push('fullScanWithFilter');
  if (signal.filesort && order.some((c) => picked.includes(c))) reasons.push('filesort');
  if (preds.some((p) => p.kind === 'join' && picked.includes(p.column))) reasons.push('joinColumn');
  if (picked.length > 1 && eq.length > 0) reasons.push('equalityFirst');
  if (firstRange && eq.length > 0) reasons.push('rangeAfterEquality');
  if (!firstRange && eq.length > 0 && order.some((c) => picked.includes(c))) reasons.push('orderAfterEquality');
  if (reasons.length === 0) return undefined;

  const risks: SuggestionRisk[] = ['writeAmplification', 'lockOnBuild', 'selectivityUnknown'];
  const lowCard = picked.some((c) => LOW_CARDINALITY_TYPE.test(columns.get(c)?.type?.trim() ?? ''));
  if (lowCard) risks.push('lowCardinality');

  // Without column statistics nothing is "high": equality on a full scan is the strongest signal.
  let confidence: SuggestionConfidence = signal.fullScan && eq.length > 0 ? 'medium' : 'low';
  if (lowCard) confidence = 'low';

  return { table: '', columns: picked, confidence, reasons, risks };
}

/**
 * Rule-based index suggestions (P10 S6).
 *
 * Only tables the plan flags (large full scan / filesort) are considered.
 * Columns come from simple predicates: equality → range → ORDER BY, never past
 * a range column, at most `maxColumns`. Primary/unique columns are excluded and
 * candidates already covered by an existing index prefix are dropped.
 * Suggestions are advisory; nothing here generates or runs DDL.
 */
export function suggestIndexes(input: IndexAdvisorInput): IndexAdvice {
  const maxColumns = input.maxColumns ?? 3;
  const maxPerTable = input.maxPerTable ?? 2;
  const signals = planSignals(input.plan, input.extraction.aliases ?? {});
  const suggestions: IndexSuggestion[] = [];
  const redundant: RedundantIndex[] = [];

  for (const table of input.tables) {
    const key = lower(table.name);
    redundant.push(...findRedundant(table));
    const signal = signals.get(key);
    if (!signal) continue;

    const columns = new Map(table.columns.map((c) => [lower(c.name), c]));
    const preds = input.extraction.predicates.filter((p) => p.table === key);
    const out: IndexSuggestion[] = [];

    const primary = buildCandidate(preds, columns, signal, maxColumns);
    if (primary && !coveredByExisting(primary.columns, table.indexes)) out.push({ ...primary, table: table.name });

    // Join columns deserve their own index when the composite starts elsewhere.
    for (const p of preds.filter((x) => x.kind === 'join')) {
      if (out.length >= maxPerTable) break;
      const col = columns.get(p.column);
      if (!col || col.isPrimary || col.isUnique) continue;
      if (out.some((s) => s.columns[0] === p.column)) continue;
      if (coveredByExisting([p.column], table.indexes)) continue;
      out.push({
        table: table.name,
        columns: [p.column],
        confidence: 'low',
        reasons: ['joinColumn'],
        risks: ['writeAmplification', 'lockOnBuild', 'selectivityUnknown'],
      });
    }
    suggestions.push(...out.slice(0, maxPerTable));
  }
  return { suggestions, redundant };
}

/** Deterministic index name: `idx_<table>_<cols>`, clipped to `maxLength`. */
export function suggestedIndexName(table: string, columns: string[], maxLength = 63): string {
  const clean = (s: string): string => s.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const base = `idx_${clean(table)}_${columns.map(clean).join('_')}`.toLowerCase();
  return base.length <= maxLength ? base : base.slice(0, maxLength).replace(/_+$/, '');
}