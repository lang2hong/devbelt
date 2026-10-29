import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { aggregateSlowQueries, aggregateSlowQueriesWithStats, fingerprintSql } from '../../src/insights/slowQueries';
import { dialectScanOptions } from '../../src/utils/sqlDialectOptions';
import type { QueryHistoryEntry } from '../../src/history/historyStore';
import { formatDuration, relativeAge, sqlPreview } from '../../webview/src/components/insights/types';

const NOW = 10_000_000_000;
let seq = 0;

function entry(sql: string, costTime: number, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry {
  seq += 1;
  return {
    id: String(seq),
    sql,
    connection: 'local',
    connectionId: 'c1',
    database: 'app',
    time: NOW - seq * 10_000,
    costTime,
    ...overrides,
  };
}

describe('fingerprintSql', () => {
  it('replaces string and number literals but keeps identifiers', () => {
    expect(fingerprintSql("SELECT * FROM users WHERE id = 42 AND name = 'bob'"))
      .toBe('SELECT * FROM users WHERE id = ? AND name = ?');
    expect(fingerprintSql('SELECT col1, t2.x FROM t2 LIMIT 10')).toBe('SELECT col1, t2.x FROM t2 LIMIT ?');
  });

  it('collapses IN lists, comments, whitespace and a trailing semicolon', () => {
    expect(fingerprintSql('SELECT *\n  FROM t -- note\n WHERE id IN (1, 2,3);'))
      .toBe('SELECT * FROM t WHERE id IN (?)');
  });

  it('treats negative and decimal numbers as literals', () => {
    expect(fingerprintSql('SELECT * FROM t WHERE a > -1.5e3')).toBe('SELECT * FROM t WHERE a > ?');
  });

  it('follows the dialect: MySQL # comments and --N arithmetic', () => {
    const mysql = dialectScanOptions(DatabaseType.MYSQL);
    const pg = dialectScanOptions(DatabaseType.PG);
    expect(fingerprintSql("SELECT * FROM t WHERE a = 'x' # note", mysql)).toBe('SELECT * FROM t WHERE a = ?');
    expect(fingerprintSql("SELECT * FROM t WHERE a = 'x' # note", pg)).toBe('SELECT * FROM t WHERE a = ? # note');
    expect(fingerprintSql('SELECT 1--2', mysql)).toBe('SELECT ?-?');
    expect(fingerprintSql('SELECT 1--2', pg)).toBe('SELECT ?');
  });
});

describe('aggregateSlowQueries', () => {
  it('groups by template and computes count/total/avg/max', () => {
    const groups = aggregateSlowQueries([
      entry('SELECT * FROM users WHERE id = 1', 100),
      entry('SELECT * FROM users WHERE id = 2', 300),
      entry('SELECT * FROM orders', 50),
    ], {}, NOW);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      fingerprint: 'SELECT * FROM users WHERE id = ?',
      count: 2,
      totalMs: 400,
      avgMs: 200,
      maxMs: 300,
      sampleSql: 'SELECT * FROM users WHERE id = 1',
    });
  });

  it('keeps connections and databases apart', () => {
    const groups = aggregateSlowQueries([
      entry('SELECT 1', 10, { connectionId: 'c1' }),
      entry('SELECT 1', 10, { connectionId: 'c2' }),
      entry('SELECT 1', 10, { connectionId: 'c1', database: 'other' }),
    ], {}, NOW);
    expect(groups).toHaveLength(3);
  });

  it('sorts by the requested metric', () => {
    const entries = [
      entry('SELECT a FROM t', 10), entry('SELECT a FROM t', 10), entry('SELECT a FROM t', 10),
      entry('SELECT b FROM t', 25),
    ];
    expect(aggregateSlowQueries(entries, { sort: 'total' }, NOW)[0].fingerprint).toBe('SELECT a FROM t');
    expect(aggregateSlowQueries(entries, { sort: 'avg' }, NOW)[0].fingerprint).toBe('SELECT b FROM t');
    expect(aggregateSlowQueries(entries, { sort: 'max' }, NOW)[0].fingerprint).toBe('SELECT b FROM t');
    expect(aggregateSlowQueries(entries, { sort: 'count' }, NOW)[0].fingerprint).toBe('SELECT a FROM t');
  });

  it('filters by connection, time range and keyword', () => {
    const entries = [
      entry('SELECT * FROM users', 10, { connectionId: 'c1', time: NOW - 60_000 }),
      entry('SELECT * FROM orders', 10, { connectionId: 'c2', time: NOW - 60_000 }),
      entry('SELECT * FROM old_t', 10, { connectionId: 'c1', time: NOW - 3 * 86_400_000 }),
    ];
    expect(aggregateSlowQueries(entries, { connectionId: 'c2' }, NOW).map((g) => g.connectionId)).toEqual(['c2']);
    expect(aggregateSlowQueries(entries, { range: '24h' }, NOW)).toHaveLength(2);
    expect(aggregateSlowQueries(entries, { range: '7d' }, NOW)).toHaveLength(3);
    expect(aggregateSlowQueries(entries, { keyword: 'ORDERS' }, NOW).map((g) => g.fingerprint)).toEqual(['SELECT * FROM orders']);
  });

  it('drops an identical record logged twice within one second', () => {
    const groups = aggregateSlowQueries([
      entry('UPDATE t SET a = 1', 40, { time: NOW - 5_000 }),
      entry('UPDATE t SET a = 1', 40, { time: NOW - 5_400 }),
      entry('UPDATE t SET a = 1', 40, { time: NOW - 9_000 }),
    ], {}, NOW);
    expect(groups[0].count).toBe(2);
    expect(groups[0].totalMs).toBe(80);
  });

  it('keeps real repeated runs that differ in cost, outcome or literals', () => {
    const groups = aggregateSlowQueries([
      entry('SELECT * FROM t WHERE id = 1', 40, { time: NOW - 5_000 }),
      entry('SELECT * FROM t WHERE id = 1', 55, { time: NOW - 5_200 }),
      entry('SELECT * FROM t WHERE id = 1', 55, { time: NOW - 5_300, failed: true }),
      entry('SELECT * FROM t WHERE id = 2', 55, { time: NOW - 5_400 }),
    ], {}, NOW);
    expect(groups[0]).toMatchObject({ count: 4, totalMs: 205, failed: 1 });
  });

  it('fingerprints per connection dialect', () => {
    const entries = [
      entry("SELECT * FROM t WHERE a = 'x' # one", 10, { connectionId: 'my' }),
      entry("SELECT * FROM t WHERE a = 'y' # two", 10, { connectionId: 'my' }),
    ];
    expect(aggregateSlowQueries(entries, {}, NOW)).toHaveLength(2);
    const groups = aggregateSlowQueries(entries, {}, NOW, (id) => (id === 'my' ? dialectScanOptions(DatabaseType.MYSQL) : undefined));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ fingerprint: 'SELECT * FROM t WHERE a = ?', count: 2 });
  });

  it('reports how many entries took part after filtering', () => {
    const entries = [
      entry('SELECT 1', 5, { connectionId: 'c1' }),
      entry('SELECT 2', 5, { connectionId: 'c1' }),
      entry('SELECT 3', 5, { connectionId: 'c2' }),
      entry('-- Imported 3 row(s)', 0, { connectionId: 'c1' }),
    ];
    expect(aggregateSlowQueriesWithStats(entries, {}, NOW).scanned).toBe(3);
    expect(aggregateSlowQueriesWithStats(entries, { connectionId: 'c1' }, NOW).scanned).toBe(2);
    expect(aggregateSlowQueriesWithStats(entries, { keyword: 'nomatch' }, NOW).scanned).toBe(0);
  });

  it('excludes bulk-operation summaries and empty SQL', () => {
    const groups = aggregateSlowQueries([
      entry('-- Imported 10 row(s) into t', 0),
      entry('   ', 0),
      entry('SELECT 1', 5),
    ], {}, NOW);
    expect(groups.map((g) => g.fingerprint)).toEqual(['SELECT ?']);
  });

  it('counts failures and treats missing flags as success', () => {
    const groups = aggregateSlowQueries([
      entry('SELECT * FROM nope', 5, { failed: true }),
      entry('SELECT * FROM nope', 5),
    ], {}, NOW);
    expect(groups[0]).toMatchObject({ count: 2, failed: 1 });
  });

  it('respects the result limit', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`SELECT c${i} FROM t`, i));
    expect(aggregateSlowQueries(entries, { limit: 5 }, NOW)).toHaveLength(5);
  });
});

describe('slow query view helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(1250)).toBe('1.25 s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('buckets relative ages', () => {
    expect(relativeAge(NOW - 10_000, NOW)).toEqual({ unit: 'justNow', n: 0 });
    expect(relativeAge(NOW - 5 * 60_000, NOW)).toEqual({ unit: 'minutes', n: 5 });
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toEqual({ unit: 'hours', n: 3 });
    expect(relativeAge(NOW - 2 * 86_400_000, NOW)).toEqual({ unit: 'days', n: 2 });
  });

  it('flattens and clips SQL previews', () => {
    expect(sqlPreview('SELECT\n  1')).toBe('SELECT 1');
    expect(sqlPreview('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});