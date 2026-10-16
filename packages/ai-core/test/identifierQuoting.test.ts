import { describe, expect, it } from 'vitest';
import { quoteReservedIdentifiers, quoteReservedIdentifiersInMarkdown } from '../src/identifierQuoting.js';

describe('quoteReservedIdentifiers（保留字补引，MySQL/PG）', () => {
  it('真机复现用例：SELECT 列表中的 condition → 补反引号', () => {
    const sql =
      'SELECT id, tenant_id, name, type, sex, condition, uuid, group_id FROM farm_animal WHERE del_flag = \'0\' LIMIT 10';
    expect(quoteReservedIdentifiers(sql, 'mysql')).toBe(
      'SELECT id, tenant_id, name, type, sex, `condition`, uuid, group_id FROM farm_animal WHERE del_flag = \'0\' LIMIT 10',
    );
  });

  it('ORDER BY / GROUP BY 关键字用法不误伤；列名用法补引', () => {
    expect(quoteReservedIdentifiers('SELECT a FROM t ORDER BY a DESC, b ASC LIMIT 10', 'mysql'))
      .toBe('SELECT a FROM t ORDER BY a DESC, b ASC LIMIT 10');
    // ORDER BY condition：condition 是列 → 必须补引
    expect(quoteReservedIdentifiers('SELECT a FROM t ORDER BY condition', 'mysql'))
      .toBe('SELECT a FROM t ORDER BY `condition`');
    // GROUP BY order：order 是列 → 补引
    expect(quoteReservedIdentifiers('SELECT a FROM t GROUP BY order', 'mysql'))
      .toBe('SELECT a FROM t GROUP BY `order`');
  });

  it('DESC/ASC 排序方向不误伤；表达式起始位的 DESC 作列名补引', () => {
    expect(quoteReservedIdentifiers('SELECT x FROM t ORDER BY x DESC', 'mysql'))
      .toBe('SELECT x FROM t ORDER BY x DESC');
    expect(quoteReservedIdentifiers('SELECT a, desc FROM t', 'mysql'))
      .toBe('SELECT a, `desc` FROM t');
    expect(quoteReservedIdentifiers('SELECT * FROM t WHERE desc = 1', 'mysql'))
      .toBe('SELECT * FROM t WHERE `desc` = 1');
  });

  it('LIMIT 数字用法不误伤；列名用法补引', () => {
    expect(quoteReservedIdentifiers('SELECT * FROM t LIMIT 10', 'mysql'))
      .toBe('SELECT * FROM t LIMIT 10');
    expect(quoteReservedIdentifiers('SELECT limit FROM t', 'mysql'))
      .toBe('SELECT `limit` FROM t');
  });

  it('RANK() 函数用法不误伤；列名用法补引', () => {
    expect(quoteReservedIdentifiers('SELECT RANK() OVER (PARTITION BY a ORDER BY b) AS r FROM t', 'mysql'))
      .toBe('SELECT RANK() OVER (PARTITION BY a ORDER BY b) AS r FROM t');
    expect(quoteReservedIdentifiers('SELECT rank FROM t', 'mysql'))
      .toBe('SELECT `rank` FROM t');
  });

  it('INTERVAL 字面量形态不误伤', () => {
    expect(quoteReservedIdentifiers("SELECT * FROM t WHERE t > NOW() - INTERVAL '7' DAY", 'mysql'))
      .toBe("SELECT * FROM t WHERE t > NOW() - INTERVAL '7' DAY");
    expect(quoteReservedIdentifiers('SELECT * FROM t WHERE t > NOW() - INTERVAL 7 DAY', 'mysql'))
      .toBe('SELECT * FROM t WHERE t > NOW() - INTERVAL 7 DAY');
  });

  it('限定列 t.condition 照样补引；表名 order 补引', () => {
    expect(quoteReservedIdentifiers('SELECT t.condition FROM t WHERE t.condition = 1', 'mysql'))
      .toBe('SELECT t.`condition` FROM t WHERE t.`condition` = 1');
    expect(quoteReservedIdentifiers('SELECT a FROM order WHERE x = 1', 'mysql'))
      .toBe('SELECT a FROM `order` WHERE x = 1');
  });

  it('CASE 系列关键字后的保留字列名补引（WHEN/THEN/ELSE/CASE 起始位）', () => {
    expect(quoteReservedIdentifiers('SELECT CASE WHEN condition = 1 THEN 1 ELSE 0 END AS r FROM t', 'mysql'))
      .toBe('SELECT CASE WHEN `condition` = 1 THEN 1 ELSE 0 END AS r FROM t');
    expect(quoteReservedIdentifiers('SELECT CASE condition WHEN 1 THEN 2 END FROM t', 'mysql'))
      .toBe('SELECT CASE `condition` WHEN 1 THEN 2 END FROM t');
    // 排序方向不受影响
    expect(quoteReservedIdentifiers('SELECT CASE WHEN x = 1 THEN a END FROM t ORDER BY x DESC', 'mysql'))
      .toBe('SELECT CASE WHEN x = 1 THEN a END FROM t ORDER BY x DESC');
  });

  it('字符串/注释/已加引标识符内一律不动', () => {
    expect(quoteReservedIdentifiers("SELECT 'condition' AS c FROM t", 'mysql'))
      .toBe("SELECT 'condition' AS c FROM t");
    expect(quoteReservedIdentifiers('SELECT `condition` FROM t -- condition note', 'mysql'))
      .toBe('SELECT `condition` FROM t -- condition note');
    expect(quoteReservedIdentifiers('SELECT a /* condition */ FROM t', 'mysql'))
      .toBe('SELECT a /* condition */ FROM t');
  });

  it('PG 方言用双引号；未知方言原样返回', () => {
    expect(quoteReservedIdentifiers('SELECT condition FROM t', 'pg'))
      .toBe('SELECT "condition" FROM t');
    expect(quoteReservedIdentifiers('SELECT condition FROM t', 'oracle'))
      .toBe('SELECT condition FROM t');
    expect(quoteReservedIdentifiers('SELECT condition FROM t'))
      .toBe('SELECT condition FROM t');
  });
});

describe('quoteReservedIdentifiersInMarkdown（围栏内才处理）', () => {
  it('只改 ```sql 围栏内的行，围栏外文本与其它语言块不动', () => {
    const md = [
      '说明 condition 用法：',
      '',
      '```sql',
      'SELECT condition FROM t LIMIT 10',
      '```',
      '',
      '```redis',
      'GET condition',
      '```',
      '',
      '尾注：condition 是列名。',
    ].join('\n');
    const out = quoteReservedIdentifiersInMarkdown(md, 'mysql');
    expect(out).toContain('SELECT `condition` FROM t LIMIT 10');
    expect(out).toContain('GET condition');
    expect(out).toContain('尾注：condition 是列名。');
  });

  it('无围栏/无方言时原样返回', () => {
    expect(quoteReservedIdentifiersInMarkdown('plain text', 'mysql')).toBe('plain text');
    const md = '```sql\nSELECT condition FROM t\n```';
    expect(quoteReservedIdentifiersInMarkdown(md)).toBe(md);
  });
});