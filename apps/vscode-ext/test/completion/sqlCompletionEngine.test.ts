import { describe, expect, it } from 'vitest';
import {
  detectContext,
  buildCandidates,
  filterByPrefix,
  extractFromTable,
  extractTableAliases,
  SQL_KEYWORDS,
} from '../../src/completion/sqlCompletionEngine';

const META = {
  tables: ['users', 'orders'],
  columns: ['id', 'name', 'age'],
  fromTable: 'users',
};

describe('detectContext', () => {
  it('detects dot_column (qualified column after table.)', () => {
    expect(detectContext('SELECT * FROM users u WHERE u.')).toBe('dot_column');
    expect(detectContext('SELECT o.')).toBe('dot_column');
  });

  it('detects after_table when a table name is complete and followed by space', () => {
    expect(detectContext('SELECT * FROM users ')).toBe('after_table');
    expect(detectContext('DELETE FROM users ')).toBe('after_table');
    expect(detectContext('UPDATE users ')).toBe('after_table');
    expect(detectContext('INSERT INTO users ')).toBe('after_table');
  });

  it('detects from_table_typing while the table name is incomplete', () => {
    expect(detectContext('SELECT * FROM ')).toBe('from_table_typing');
    expect(detectContext('SELECT * FROM us')).toBe('from_table_typing');
    expect(detectContext('UPDATE u')).toBe('from_table_typing');
  });

  it('detects order_clause after ORDER BY / GROUP BY', () => {
    expect(detectContext('SELECT * FROM users ORDER BY ')).toBe('order_clause');
    expect(detectContext('SELECT * FROM users GROUP BY na')).toBe('order_clause');
  });

  it('detects where_condition after WHERE/HAVING/AND/OR', () => {
    expect(detectContext('SELECT * FROM users WHERE ')).toBe('where_condition');
    expect(detectContext('SELECT * FROM users WHERE ag')).toBe('where_condition');
    expect(detectContext('SELECT * FROM users WHERE age > 18 AND ')).toBe('where_condition');
  });

  it('detects where_operator after a field (waiting for a comparison operator)', () => {
    expect(detectContext('SELECT * FROM users WHERE age ')).toBe('where_operator');
    expect(detectContext('SELECT * FROM users WHERE age > 18 AND id ')).toBe('where_operator');
  });

  it('detects where_value after a comparison operator', () => {
    expect(detectContext('SELECT * FROM users WHERE age > ')).toBe('where_value');
    expect(detectContext('SELECT * FROM users WHERE name LIKE ')).toBe('where_value');
    expect(detectContext('SELECT * FROM users WHERE id IN ')).toBe('where_value');
  });

  it('detects set_clause after UPDATE ... SET', () => {
    expect(detectContext('UPDATE users SET ')).toBe('set_clause');
    expect(detectContext('UPDATE users SET na')).toBe('set_clause');
  });

  it('detects select_clause before FROM is reached', () => {
    expect(detectContext('SELECT ')).toBe('select_clause');
    expect(detectContext('SELECT na')).toBe('select_clause');
  });

  it('detects statement_start on empty or after a semicolon', () => {
    expect(detectContext('')).toBe('statement_start');
    expect(detectContext('   ')).toBe('statement_start');
    expect(detectContext('SELECT * FROM users; ')).toBe('statement_start');
  });

  it('falls back to default for other positions', () => {
    expect(detectContext('SELECT * FROM users WHERE age > 30 ')).toBe('default');
    // 无尾空格时无法判定表名是否完整，仍按“正在输入表名”处理（打空格后切到 after_table）
    expect(detectContext('SELECT * FROM users')).toBe('from_table_typing');
  });
});

describe('buildCandidates', () => {
  it('dot_column returns columns (or functions when no columns)? else functions', () => {
    const cols = buildCandidates('dot_column', { ...META, columns: ['id'] }).map((c) => c.label);
    expect(cols).toEqual(['id']);
    const fns = buildCandidates('dot_column', { ...META, columns: [] }).map((c) => c.kind);
    expect(fns).toContain('function');
  });

  it('from_table_typing returns tables only', () => {
    const items = buildCandidates('from_table_typing', META);
    expect(items.every((c) => c.kind === 'table')).toBe(true);
    expect(items.map((c) => c.label)).toEqual(['users', 'orders']);
  });

  it('select_clause mixes columns, functions and keywords', () => {
    const items = buildCandidates('select_clause', META);
    const kinds = new Set(items.map((c) => c.kind));
    expect(kinds.has('column')).toBe(true);
    expect(kinds.has('function')).toBe(true);
    expect(kinds.has('keyword')).toBe(true);
    expect(items.map((c) => c.label)).toContain('DISTINCT');
    expect(items.map((c) => c.label)).toContain('*');
  });

  it('statement_start offers statements and tables', () => {
    const items = buildCandidates('statement_start', META);
    expect(items.map((c) => c.label)).toContain('SELECT');
    expect(items.map((c) => c.label)).toContain('users');
  });

  it('every known context returns a non-empty candidate list', () => {
    const contexts = [
      'statement_start', 'select_clause', 'from_table_typing', 'after_table',
      'where_condition', 'order_clause', 'set_clause', 'dot_column', 'default',
    ];
    for (const ctx of contexts) {
      expect(buildCandidates(ctx as any, META).length).toBeGreaterThan(0);
    }
  });
});

describe('filterByPrefix', () => {
  it('is case-insensitive and filters by prefix', () => {
    const items = [
      { label: 'WHERE', kind: 'keyword' as const },
      { label: 'WITH', kind: 'keyword' as const },
      { label: 'name', kind: 'column' as const },
    ];
    expect(filterByPrefix(items, 'w')).toEqual([items[0], items[1]]);
    expect(filterByPrefix(items, 'W')).toEqual([items[0], items[1]]);
    expect(filterByPrefix(items, 'na')).toEqual([items[2]]);
  });

  it('returns everything when prefix is empty', () => {
    const items = [{ label: 'a', kind: 'keyword' as const }];
    expect(filterByPrefix(items, '')).toEqual(items);
  });
});

describe('extractFromTable', () => {
  it('extracts simple and qualified table names', () => {
    expect(extractFromTable('SELECT * FROM users')).toBe('users');
    expect(extractFromTable('SELECT * FROM mydb.users')).toBe('users');
    expect(extractFromTable('SELECT * FROM `users`')).toBe('users');
  });

  it('returns undefined when there is no FROM', () => {
    expect(extractFromTable('SELECT 1')).toBeUndefined();
  });
});

describe('SQL_KEYWORDS', () => {
  it('exposes the keyword buckets used to build candidates', () => {
    expect(SQL_KEYWORDS.statement).toContain('SELECT');
    expect(SQL_KEYWORDS.clause).toContain('FROM');
    expect(SQL_KEYWORDS.operator).toContain('AND');
    expect(SQL_KEYWORDS.functions).toContain('COUNT');
  });
});

describe('extractTableAliases', () => {
  it('解析 FROM/JOIN 的表与别名映射，忽略保留字', () => {
    const sql = 'SELECT u.name FROM `users` u LEFT JOIN orders AS o ON o.uid = u.id WHERE x = 1';
    const map = extractTableAliases(sql);
    expect(map.get('u')).toBe('users');
    expect(map.get('o')).toBe('orders');
    expect(map.get('users')).toBe('users');
    expect(map.has('LEFT')).toBe(false);
    expect(map.has('WHERE')).toBe(false);
  });

  it('无别名时映射回表名自身', () => {
    const map = extractTableAliases('SELECT * FROM db1.accounts');
    expect(map.get('accounts')).toBe('accounts');
  });

  it('无显式别名时不会把 JOIN 当别名而吞掉第二张表', () => {
    const map = extractTableAliases('SELECT * FROM users JOIN orders ON orders.uid = users.id');
    expect(map.get('users')).toBe('users');
    expect(map.get('orders')).toBe('orders');
    expect(map.has('JOIN')).toBe(false);
  });

  it('无显式别名时 JOIN 后的表带别名仍被解析', () => {
    const map = extractTableAliases('SELECT * FROM users JOIN orders o ON o.uid = users.id');
    expect(map.get('o')).toBe('orders');
    expect(map.get('orders')).toBe('orders');
  });
});
