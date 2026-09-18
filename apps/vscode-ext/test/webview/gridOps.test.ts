import { describe, expect, it } from 'vitest';
import {
  buildInsertPayload,
  buildInsertStatement,
  deleteRowsMessage,
  identifierQuote,
  quoteLiteral,
  updateCellMessage,
} from '../../webview/src/utils/gridOps';

describe('gridOps 方言引用', () => {
  it('MySQL 用反引号，PG/SQLite 用双引号并转义内部引号', () => {
    expect(identifierQuote('MYSQL', 'a`b')).toBe('`a`b`');
    expect(identifierQuote('PG', 'a"b')).toBe('"a""b"');
    expect(identifierQuote('SQLITE', 't')).toBe('"t"');
  });

  it('字面量转义单引号，null/undefined 为 NULL', () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
    expect(quoteLiteral(null)).toBe('NULL');
    expect(quoteLiteral(undefined)).toBe('NULL');
  });
});

describe('gridOps 插入列语义', () => {
  it('留空的列被省略（走数据库默认值/自增），不再写 NULL', () => {
    const { columns, values } = buildInsertPayload(['a', 'b', 'c'], { a: 'x', b: '', c: undefined });
    expect(columns).toEqual(['a']);
    expect(values).toEqual(['x']);
  });

  it('字面 NULL（大小写不敏感）为显式 SQL NULL', () => {
    const { columns, values } = buildInsertPayload(['a', 'b'], { a: 'null', b: 'NULL' });
    expect(columns).toEqual(['a', 'b']);
    expect(values).toEqual([null, null]);
  });

  it('空字符串无法通过该约定表达（会被当作留空省略）', () => {
    expect(buildInsertPayload(['a'], { a: '' }).columns).toEqual([]);
  });
});

describe('gridOps 复制 INSERT', () => {
  it('按方言生成，且 NULL 用 NULL 字面量', () => {
    const sql = buildInsertStatement('users', 'db', ['id', 'name'], [{ id: 1, name: null }], 'PG');
    expect(sql).toBe('INSERT INTO "db"."users" ("id", "name") VALUES (1, NULL);');
  });

  it('MySQL 用反引号', () => {
    const sql = buildInsertStatement('t', undefined, ['a'], [{ a: 'x' }], 'MYSQL');
    expect(sql).toBe("INSERT INTO `t` (`a`) VALUES ('x');");
  });

  it('无表或空行时返回空串', () => {
    expect(buildInsertStatement(undefined, 'd', ['a'], [{ a: 1 }], 'PG')).toBe('');
    expect(buildInsertStatement('t', 'd', ['a'], [], 'PG')).toBe('');
  });
});

describe('gridOps 消息契约', () => {
  it('updateCell 使用 pkColumns/pkValues（不是 pkColumn/rowId）', () => {
    const msg = updateCellMessage(['id', 'k'], [1, 'a'], 'name', 'x');
    expect(msg).toEqual({ type: 'updateCell', pkColumns: ['id', 'k'], pkValues: [1, 'a'], column: 'name', value: 'x' });
    // 与扩展侧 tableQueryView 读取的字段一致
    expect(msg).toHaveProperty('pkColumns');
    expect(msg).toHaveProperty('pkValues');
  });

  it('deleteRows 逐行携带 pkColumns/pkValues', () => {
    const msg = deleteRowsMessage([{ pkColumns: ['id'], pkValues: [1] }]);
    expect(msg.rows[0]).toEqual({ pkColumns: ['id'], pkValues: [1] });
  });
});
