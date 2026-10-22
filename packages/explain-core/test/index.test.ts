import { describe, expect, it } from 'vitest';
import { parseExplain } from '../src/index.js';

describe('parseExplain', () => {
  it('dispatches by dialect', () => {
    const mysql = parseExplain('mysql', { query_block: { select_id: 1 } });
    const postgres = parseExplain('postgres', [{ Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1, 'Total Cost': 1 } }]);
    const sqlite = parseExplain('sqlite', [{ id: 1, parent: 0, detail: 'SCAN t' }]);

    expect(mysql.ok).toBe(true);
    expect(postgres.ok).toBe(true);
    expect(sqlite.ok).toBe(true);
  });
});