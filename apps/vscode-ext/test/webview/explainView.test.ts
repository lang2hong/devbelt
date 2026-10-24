import { describe, expect, it } from 'vitest';
import type { ExplainPlanNode, ExplainWarning } from '@devbelt/explain-core';
import { en, zh } from '../../src/i18n/catalog';
import {
  collectPlanIds,
  findPlanNode,
  flattenPlan,
  formatMs,
  formatNumber,
  WARNING_HELP_KEYS,
  WARNING_LABEL_KEYS,
  warningClass,
  warningSeverity,
  buildPlanSummary,
  OPERATION_LABEL_KEYS,
  operationLabel,
  planHasActuals,
  planTableRows,
  buildPlanGrid,
  classicRowFlags,
  deriveClassicRows,
  GRID_LABEL_KEYS,
} from '../../webview/src/components/explain/types';

const leaf: ExplainPlanNode = {
  id: '2',
  operation: 'Index Scan',
  object: 'users',
  index: 'users_pkey',
  warnings: ['missingIndex'],
  children: [],
};
const root: ExplainPlanNode = {
  id: '1',
  operation: 'Nested Loop',
  warnings: ['nestedLoop'],
  children: [leaf],
};

describe('explain view helpers', () => {
  it('flattens only expanded branches', () => {
    expect(flattenPlan([root], new Set(['1'])).map((row) => [row.node.id, row.depth])).toEqual([
      ['1', 0],
      ['2', 1],
    ]);
    expect(flattenPlan([root], new Set()).map((row) => row.node.id)).toEqual(['1']);
  });

  it('collects and finds nodes deterministically', () => {
    expect(collectPlanIds([root])).toEqual(['1', '2']);
    expect(findPlanNode([root], '2')).toBe(leaf);
    expect(findPlanNode([root], 'missing')).toBeUndefined();
    expect(findPlanNode([root], null)).toBeUndefined();
  });

  it('has warning labels in both catalogs', () => {
    for (const warning of Object.keys(WARNING_LABEL_KEYS) as ExplainWarning[]) {
      const key = WARNING_LABEL_KEYS[warning];
      expect(en[key], key).toBeTruthy();
      expect(zh[key], key).toBeTruthy();
      expect(warningClass(warning)).toBe(`warn-${warning}`);
    }
  });

  it('formats metrics without NaN', () => {
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatMs(1.23456)).toBe('1.235 ms');
    expect(formatMs(undefined)).toBe('—');
  });
});
describe('explain view overview helpers', () => {
  const scan = (over: Partial<ExplainPlanNode> = {}): ExplainPlanNode => ({
    id: 's', operation: 'Table scan', object: 'oms_order', estimatedRows: 2589, warnings: ['fullTableScan'], children: [], ...over,
  });
  const wrap = (child: ExplainPlanNode): ExplainPlanNode => ({ id: 'q', operation: 'Query block', warnings: [], children: [child] });
  const keys = (items: { key: string }[]): string[] => items.map((i) => i.key);

  it('treats an unfiltered full scan as expected, a filtered one as a problem', () => {
    const plain = buildPlanSummary({ roots: [wrap(scan())] }, { analyzed: false, suggestionCount: 0 });
    expect(keys(plain)).toEqual(['wv.explain.summary.scanAll']);
    expect(keys(buildPlanSummary({ roots: [wrap(scan({ warnings: [] }))] }, { analyzed: false, suggestionCount: 0 })))
      .toEqual(['wv.explain.summary.noProblem']);
    expect(warningSeverity('fullTableScan', scan())).toBe('info');

    const filtered = scan({ filter: 'status = 1', warnings: ['fullTableScan', 'missingIndex'] });
    const items = buildPlanSummary({ roots: [wrap(filtered)] }, { analyzed: false, suggestionCount: 1 });
    expect(items[0]).toMatchObject({ level: 'warn', key: 'wv.explain.summary.scanFiltered', vars: { table: 'oms_order', rows: '2,589' } });
    expect(keys(items)).toContain('wv.explain.summary.seeSuggestions');
    expect(keys(items)).not.toContain('wv.explain.summary.noProblem');
    expect(warningSeverity('fullTableScan', filtered)).toBe('warn');
  });

  it('reports the slowest table and misestimates after Analyze', () => {
    const roots = [wrap(scan({ estimatedRows: 10, actualRows: 5000, actualTimeMs: 2, loops: 3, warnings: [] }))];
    const items = buildPlanSummary({ roots, executionTimeMs: 7.5 }, { analyzed: true, suggestionCount: 0 });
    // Total time is shown by the mode badge, not repeated in the summary.
    expect(keys(items)).not.toContain('wv.explain.summary.executionTime');
    expect(items.find((i) => i.key === 'wv.explain.summary.slowest')?.vars).toEqual({ table: 'oms_order', ms: '6.000' });
    expect(keys(items)).toContain('wv.explain.summary.misestimate');
  });

  it('lists the same problem once per table', () => {
    const items = buildPlanSummary({ roots: [wrap(scan()), wrap(scan())] }, { analyzed: false, suggestionCount: 0 });
    expect(keys(items)).toEqual(['wv.explain.summary.scanAll']);
  });

  it('skips wrapper steps in the plan table', () => {
    const rows = planTableRows([wrap(scan())]);
    expect(rows.map((r) => [r.node.operation, r.depth])).toEqual([['Table scan', 0]]);
    expect(planHasActuals([wrap(scan())])).toBe(false);
    expect(planHasActuals([wrap(scan({ actualRows: 1 }))])).toBe(true);
  });

  it('localizes every operation name and keeps engine details', () => {
    for (const [name, suffix] of Object.entries(OPERATION_LABEL_KEYS)) {
      const key = `wv.explain.op.${suffix}`;
      expect(en[key], `${name} → ${key}`).toBeTruthy();
      expect(zh[key], `${name} → ${key}`).toBeTruthy();
    }
    const zt = (key: string): string => zh[key] ?? key;
    expect(operationLabel('Table scan', zt)).toBe('全表扫描');
    expect(operationLabel('Seq Scan', zt)).toBe('全表扫描');
    expect(operationLabel('Limit: 100 row(s)', zt)).toBe('限制行数: 100 row(s)');
    expect(operationLabel('Temporary B-tree (ORDER BY)', zt)).toBe('临时 B 树 (ORDER BY)');
    expect(operationLabel('Something new', zt)).toBe('Something new');
  });

  it('covers every operation name the parsers emit', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../../../packages/explain-core/src');
    const names = new Set<string>();
    for (const file of ['mysql.ts', 'sqlite.ts', 'mysqlAnalyze.ts']) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      for (const m of text.matchAll(/operation(?:\s*=|:)\s*'([^']+)'/g)) names.add(m[1]!);
      for (const m of text.matchAll(/'(Join item|Query specification|Subquery)'/g)) names.add(m[1]!);
      for (const m of text.matchAll(/\?\s*'([^']+)'\s*:/g)) names.add(m[1]!);
    }
    for (const m of readFileSync(path.join(dir, 'sqlite.ts'), 'utf8').matchAll(/:\s*'([A-Z][a-z][^']*)'\s*[,)]?\s*$/gm)) names.add(m[1]!);
    names.delete('mysql');
    const missing = [...names].filter((name) => !(name in OPERATION_LABEL_KEYS));
    expect(missing).toEqual([]);
  });

  it('has help text for every warning', () => {
    for (const key of Object.values(WARNING_HELP_KEYS)) {
      expect(en[key], key).toBeTruthy();
      expect(zh[key], key).toBeTruthy();
    }
  });
});

describe('plan grid (Table tab)', () => {
  // The plan the user pasted from the panel (MySQL 8, decoded EXPLAIN column).
  const USED = ['order_id', 'order_title', 'order_code'];
  const OMS_RAW = [{
    EXPLAIN: {
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '283.15' },
        table: {
          table_name: 'oms_order', access_type: 'ALL', rows_examined_per_scan: 2589, rows_produced_per_join: 2589, filtered: '100.00',
          cost_info: { read_cost: '24.25', eval_cost: '258.90', prefix_cost: '283.15', data_read_per_join: '6M' },
          used_columns: USED,
        },
      },
    },
  }];
  const omsNode: ExplainPlanNode = { id: 'm.0', operation: 'Table scan', object: 'oms_order', estimatedRows: 2589, warnings: ['fullTableScan'], children: [] };
  const mysqlPlan = (raw: unknown, roots: ExplainPlanNode[] = [{ id: 'm', operation: 'Query block', warnings: [], children: [omsNode] }]) =>
    ({ dialect: 'mysql' as const, roots, raw });

  // Captured from MySQL 8.0.36 via mysql2 (db_client_verify, temporary tables).
  const CLASSIC_JOIN = [
    { id: 1, select_type: 'SIMPLE', table: 'o', partitions: null, type: 'ALL', possible_keys: 'k_uid', key: null, key_len: null, ref: null, rows: 1, filtered: 100, Extra: 'Using where; Using temporary; Using filesort' },
    { id: 1, select_type: 'SIMPLE', table: 'u', partitions: null, type: 'eq_ref', possible_keys: 'PRIMARY', key: 'PRIMARY', key_len: '4', ref: 'db_client_verify.o.uid', rows: 1, filtered: 100, Extra: null },
  ];

  it('shows the traditional EXPLAIN columns for MySQL', () => {
    const grid = buildPlanGrid({ plan: mysqlPlan(OMS_RAW), classicRows: CLASSIC_JOIN }, false)!;
    expect(grid.kind).toBe('classic');
    expect(grid.columns.map((c) => c.label)).toEqual(['id', 'select_type', 'table', 'type', 'possible_keys', 'key', 'key_len', 'ref', 'rows', 'filtered', 'Extra']);
    expect(grid.columns.every((c) => c.literal)).toBe(true);
    expect(grid.rows[1]!.cells).toMatchObject({ table: 'u', type: 'eq_ref', key: 'PRIMARY', key_len: '4', ref: 'db_client_verify.o.uid', filtered: '100%', Extra: '' });
    expect(grid.figures).toEqual([{ key: 'wv.explain.figure.queryCost', value: '283.15' }]);
    // Small table: sort/temporary still flagged, the 1-row scan is not.
    expect(grid.rows[0]!.level).toBe('warn');
    expect(grid.rows[0]!.notes).toEqual(['wv.explain.note.filesort', 'wv.explain.note.temporary']);
    expect(grid.rows[1]!.level).toBeUndefined();
  });

  it('highlights a large filtered full scan but only notes an unfiltered one', () => {
    expect(classicRowFlags('ALL', 2589, '')).toEqual({ level: 'info', notes: ['wv.explain.note.scanAll'] });
    expect(classicRowFlags('ALL', 2589, 'Using where')).toEqual({ level: 'warn', notes: ['wv.explain.note.scanFiltered'] });
    expect(classicRowFlags('ALL', 10, 'Using where')).toEqual({ notes: [] });
    expect(classicRowFlags('ref', 50000, 'Using index')).toEqual({ notes: [] });
  });

  it('derives the classic columns from JSON when the traditional EXPLAIN is missing', () => {
    const grid = buildPlanGrid({ plan: mysqlPlan(OMS_RAW) }, false)!;
    expect(grid.kind).toBe('derived');
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]!.cells).toMatchObject({ id: '1', select_type: '', table: 'oms_order', type: 'ALL', rows: '2,589', filtered: '100.00%', Extra: '' });
    expect(grid.rows[0]!.level).toBe('info');
  });

  it('puts sort and temporary flags on the first table, like MySQL does', () => {
    const raw = [{
      EXPLAIN: {
        query_block: {
          select_id: 1,
          ordering_operation: {
            using_filesort: true,
            grouping_operation: {
              using_temporary_table: true,
              nested_loop: [
                { table: { table_name: 'o', access_type: 'ALL', possible_keys: ['k_uid'], rows_examined_per_scan: 300, attached_condition: "(`o`.`status` = 's1')" } },
                { table: { table_name: 'u', access_type: 'eq_ref', possible_keys: ['PRIMARY'], key: 'PRIMARY', key_length: '4', ref: ['db.o.uid'], rows_examined_per_scan: 1 } },
              ],
            },
          },
        },
      },
    }];
    const rows = deriveClassicRows(raw)!;
    expect(rows.map((r) => [r.table, r.Extra])).toEqual([
      ['o', 'Using where; Using temporary; Using filesort'],
      ['u', null],
    ]);
    expect(rows[1]).toMatchObject({ key: 'PRIMARY', key_len: '4', ref: ['db.o.uid'] });
  });

  it('lists steps with actual figures for MySQL EXPLAIN ANALYZE', () => {
    const roots: ExplainPlanNode[] = [{
      id: 'a0', operation: 'Limit: 100 row(s)', estimatedRows: 100, actualRows: 100, actualTimeMs: 0.8, loops: 1, warnings: [],
      children: [{ id: 'a1', operation: 'Table scan', object: 'oms_order', estimatedRows: 2589, actualRows: 100, actualTimeMs: 0.05, loops: 1, warnings: ['fullTableScan'], children: [] }],
    }];
    const grid = buildPlanGrid({ plan: mysqlPlan('-> Limit…', roots), classicRows: CLASSIC_JOIN }, true)!;
    expect(grid.kind).toBe('steps');
    expect(grid.columns.map((c) => c.key)).toEqual(['step', 'object', 'estRows', 'actualRows', 'actualTime', 'loops']);
    expect(grid.rows.map((r) => [r.cells.step, r.depth, r.cells.actualRows])).toEqual([['Limit: 100 row(s)', 0, '100'], ['Table scan', 1, '100']]);
    expect(grid.rows[1]!.notes).toEqual(['wv.explain.note.scanAll']);
  });

  it('flattens a PostgreSQL plan with depth, conditions and timings', () => {
    const raw = [{
      Plan: {
        'Node Type': 'Nested Loop', 'Join Type': 'Inner', 'Startup Cost': 0, 'Total Cost': 120, 'Plan Rows': 10, 'Plan Width': 8,
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Alias: 'o', 'Total Cost': 20, 'Plan Rows': 5000, Filter: "(status = 'paid'::text)" },
          { 'Node Type': 'Index Scan', 'Relation Name': 'users', Alias: 'users', 'Index Name': 'users_pkey', 'Index Cond': '(id = o.user_id)', 'Total Cost': 8, 'Plan Rows': 1 },
        ],
      },
      'Planning Time': 0.2,
      'Execution Time': 1.5,
    }];
    const roots: ExplainPlanNode[] = [{
      id: 'p', operation: 'Nested Loop', warnings: ['nestedLoop'], children: [
        { id: 'p.0', operation: 'Seq Scan', object: 'orders', filter: "(status = 'paid'::text)", warnings: ['fullTableScan', 'missingIndex'], children: [] },
        { id: 'p.1', operation: 'Index Scan', object: 'users', warnings: [], children: [] },
      ],
    }];
    const grid = buildPlanGrid({ plan: { dialect: 'postgres', roots, raw } }, false)!;
    expect(grid.kind).toBe('postgres');
    expect(grid.rows.map((r) => [r.cells.nodeType, r.depth, r.cells.table, r.cells.alias, r.cells.key])).toEqual([
      ['Nested Loop', 0, '', '', ''],
      ['Seq Scan', 1, 'orders', 'o', ''],
      ['Index Scan', 1, 'users', '', 'users_pkey'],
    ]);
    expect(grid.rows[1]).toMatchObject({ level: 'warn', notes: ['wv.explain.note.scanFiltered'] });
    expect(grid.rows[1]!.cells.condition).toBe("Filter: (status = 'paid'::text)");
    expect(grid.figures.map((f) => f.value)).toEqual(['0.20 ms', '1.50 ms']);
  });

  it('shows SQLite plan rows with scan and temp B-tree notes', () => {
    const raw = [
      { id: 2, parent: 0, notused: 0, detail: 'SCAN users' },
      { id: 3, parent: 0, notused: 0, detail: 'SEARCH orders USING INDEX idx_user (user_id=?)' },
      { id: 4, parent: 0, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ];
    const grid = buildPlanGrid({ plan: { dialect: 'sqlite', roots: [], raw } }, false)!;
    expect(grid.rows.map((r) => [r.cells.detail, r.level, r.notes])).toEqual([
      ['SCAN users', 'info', ['wv.explain.note.sqliteScan']],
      ['SEARCH orders USING INDEX idx_user (user_id=?)', undefined, []],
      ['USE TEMP B-TREE FOR ORDER BY', 'warn', ['wv.explain.note.filesort']],
    ]);
  });

  it('shows legacy fallback rows with their own columns', () => {
    const classic = buildPlanGrid({ plan: null, fallback: { rows: CLASSIC_JOIN } }, false)!;
    expect(classic.kind).toBe('classic');
    const flat = buildPlanGrid({ plan: null, fallback: { rows: [{ QUERY_PLAN: 'Seq Scan on t' }] } }, false)!;
    expect(flat).toMatchObject({ kind: 'flat', columns: [{ key: 'QUERY_PLAN', literal: true }] });
    expect(buildPlanGrid({ plan: null, fallback: { rows: [] } }, false)).toBeUndefined();
  });

  it('falls back to steps when the raw plan was dropped for size', () => {
    const grid = buildPlanGrid({ plan: mysqlPlan(null) }, false)!;
    expect(grid.kind).toBe('steps');
    expect(grid.rows[0]!.cells.object).toBe('oms_order');
  });

  it('has a label for every grid column', () => {
    for (const key of GRID_LABEL_KEYS) {
      expect(en[key], key).toBeTruthy();
      expect(zh[key], key).toBeTruthy();
    }
  });
});
