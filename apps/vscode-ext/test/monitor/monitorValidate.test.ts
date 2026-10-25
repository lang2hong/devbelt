import { describe, expect, it } from 'vitest';
import type { ColumnMeta, IndexMeta } from '@devbelt/db-core';
import { checkCursorColumn, checkMetricResult, checkMetricSql, cursorKindOf, toMetricNumber } from '../../src/monitor/monitorValidate';

function col(name: string, type: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name, type, simpleType: type.split('(')[0]!, comment: '', key: '', nullable: 'NO', maxLength: '', defaultValue: null,
    extra: '', isNotNull: true, isAutoIncrement: false, isUnique: false, isPrimary: false, pk: '', ...over,
  };
}
const idx = (name: string, columns: string[]): IndexMeta => ({ name, columns, isUnique: false, isPrimary: false });

describe('A2 metric SQL', () => {
  it('accepts one read-only SELECT and strips the trailing semicolon', () => {
    const r = checkMetricSql('SELECT COUNT(*) AS n FROM t;', 'MYSQL');
    expect(r).toEqual({ ok: true, statement: 'SELECT COUNT(*) AS n FROM t' });
  });

  it.each([
    ['DELETE FROM t', 'notReadOnly'],
    ['SELECT 1; SELECT 2', 'notReadOnly'],
    ['SELECT * FROM t FOR UPDATE', 'notReadOnly'],
    ['EXPLAIN SELECT 1', 'notSelect'],
    ['SELECT pg_sleep(10)', 'notReadOnly'],
  ])('rejects %s', (sql, code) => {
    const r = checkMetricSql(sql, sql.includes('pg_') ? 'PG' : 'MYSQL');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe(code);
  });

  it('accepts the user\'s lc_data_event freshness query shape', () => {
    const sql = `SELECT UNIX_TIMESTAMP()*1000 AS db_now_ms, COUNT(*) AS total_rows,
      ROUND((UNIX_TIMESTAMP()*1000 - MAX(received_time))/1000) AS lag_seconds,
      SUM(received_time >= UNIX_TIMESTAMP()*1000 - 3600000) AS rows_last_1h
      FROM lc_data_event`;
    expect(checkMetricSql(sql, 'MYSQL').ok).toBe(true);
    const shape = checkMetricResult([{ db_now_ms: '1792891347000', total_rows: 74, lag_seconds: '34165', rows_last_1h: '0' }], 'lag_seconds');
    expect(shape).toMatchObject({ ok: true, watchColumn: 'lag_seconds', columns: ['db_now_ms', 'total_rows', 'lag_seconds', 'rows_last_1h'] });
    expect(shape.values).toEqual({ db_now_ms: 1792891347000, total_rows: 74, lag_seconds: 34165, rows_last_1h: 0 });
  });
});

describe('A2 result shape', () => {
  it('requires exactly one row and 1–10 numeric columns', () => {
    expect(checkMetricResult([], undefined).issues[0]!.code).toBe('noRows');
    expect(checkMetricResult([{ a: 1 }, { a: 2 }], undefined).issues[0]!.code).toBe('tooManyRows');
    const wide = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`c${i}`, i]));
    expect(checkMetricResult([wide], undefined).issues[0]!.code).toBe('tooManyColumns');
    expect(checkMetricResult([{ a: 'abc' }], undefined).issues).toEqual([{ level: 'error', code: 'nonNumeric', detail: 'a' }]);
  });

  it('treats NULL as a missing value and defaults the watch column to the first column', () => {
    const r = checkMetricResult([{ max_id: null, n: 3 }], undefined);
    expect(r).toMatchObject({ ok: true, watchColumn: 'max_id', values: { max_id: null, n: 3 } });
    expect(checkMetricResult([{ n: 3 }], 'missing').issues[0]!.code).toBe('watchColumnMissing');
  });

  it('parses numbers, numeric strings, bigint and booleans', () => {
    expect(toMetricNumber('12.5')).toBe(12.5);
    expect(toMetricNumber(5n)).toBe(5);
    expect(toMetricNumber(true)).toBe(1);
    expect(toMetricNumber('')).toBeNull();
    expect(toMetricNumber({})).toBeUndefined();
  });
});

describe('B cursor column', () => {
  it('classifies cursor types per dialect', () => {
    expect(cursorKindOf('MYSQL', 'bigint(20)')).toBe('integer');
    expect(cursorKindOf('MYSQL', 'tinyint(1)')).toBeUndefined();
    expect(cursorKindOf('MYSQL', 'datetime(3)')).toBe('temporal');
    expect(cursorKindOf('MYSQL', 'varchar(32)')).toBeUndefined();
    expect(cursorKindOf('PG', 'timestamp with time zone')).toBe('temporal');
    expect(cursorKindOf('PG', 'bigserial')).toBe('integer');
    expect(cursorKindOf('SQLITE', 'INTEGER')).toBe('integer');
    expect(cursorKindOf('SQLITE', 'TEXT')).toBeUndefined();
    expect(cursorKindOf('SQLITE', 'DATETIME')).toBeUndefined();
  });

  it('accepts an indexed integer column with a primary key without warnings', () => {
    const r = checkCursorColumn({
      dbType: 'MYSQL', table: 'lc_data_event', column: 'id',
      columns: [col('id', 'bigint', { isPrimary: true }), col('received_time', 'bigint')],
      indexes: [],
    });
    expect(r).toEqual({ ok: true, issues: [], cursorKind: 'integer', primaryKey: ['id'] });
  });

  it('warns about nullable, unindexed columns and tables without a primary key', () => {
    const r = checkCursorColumn({
      dbType: 'MYSQL', table: 'events', column: 'received_time',
      columns: [col('received_time', 'bigint', { isNotNull: false })],
      indexes: [idx('idx_other', ['kind', 'received_time'])],
    });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(['nullable', 'noIndex', 'noPrimaryKey']);
  });

  it('accepts an index whose first column is the cursor', () => {
    const r = checkCursorColumn({
      dbType: 'PG', table: 'orders', column: 'created_at',
      columns: [col('id', 'integer', { isPrimary: true }), col('created_at', 'timestamp without time zone')],
      indexes: [idx('idx_created', ['created_at'])],
    });
    expect(r.issues).toEqual([]);
    expect(r.cursorKind).toBe('temporal');
  });

  it('rejects missing tables, missing columns, unsupported types and bad identifiers', () => {
    const base = { dbType: 'MYSQL', table: 't', indexes: [] as IndexMeta[] };
    expect(checkCursorColumn({ ...base, column: 'id', columns: [] }).issues[0]!.code).toBe('tableMissing');
    expect(checkCursorColumn({ ...base, column: 'created_time', columns: [col('id', 'int')] }).issues[0]!.code).toBe('columnMissing');
    expect(checkCursorColumn({ ...base, column: 'name', columns: [col('name', 'varchar(20)')] }).issues[0]!.code).toBe('cursorType');
    expect(checkCursorColumn({ ...base, column: 'a`b', columns: [col('a`b', 'int')] }).issues[0]!.code).toBe('identifier');
  });
});
