import { describe, expect, it } from 'vitest';
import { streamRowsByKeyset } from '../../src/query/paging';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { SqliteDialect } from '../../src/dialect/sqliteDialect';

function sourceOf(pages: Array<Array<Record<string, unknown>>>) {
  const executed: string[] = [];
  return {
    executed,
    source: {
      query: async (sql: string) => {
        executed.push(sql);
        return { rows: pages.shift() ?? [] };
      },
    },
  };
}

describe('streamRowsByKeyset（keyset 分页单一来源）', () => {
  it('有主键：首页 ORDER BY，续页展开式标量比较，页空即止', async () => {
    const { source, executed } = sourceOf([[{ id: 1 }], [{ id: 2 }], []]);
    const out: Array<Array<Record<string, unknown>>> = [];
    for await (const rows of streamRowsByKeyset(source, new MysqlDialect(), 'SELECT * FROM `t`', ['id'], 1)) {
      out.push(rows);
    }
    expect(executed[0]).toBe('SELECT * FROM `t` ORDER BY `id` LIMIT 1');
    expect(executed[1]).toBe('SELECT * FROM `t` WHERE (`id` > 1) ORDER BY `id` LIMIT 1');
    expect(executed[2]).toBe('SELECT * FROM `t` WHERE (`id` > 2) ORDER BY `id` LIMIT 1');
    expect(out.map((r) => r.length)).toEqual([1, 1, 0]);
  });

  it('复合主键：展开为 (a>v1) OR (a=v1 AND b>v2)', async () => {
    const { source, executed } = sourceOf([[{ a: 1, b: 'x' }], []]);
    for await (const _ of streamRowsByKeyset(source, new MysqlDialect(), 'SELECT * FROM `t`', ['a', 'b'], 1)) {
      void _;
    }
    expect(executed[1]).toContain('WHERE (`a` > 1) OR (`a` = 1 AND `b` > \'x\')');
  });

  it('无主键：回退 OFFSET 分页，offset 逐页递增', async () => {
    const { source, executed } = sourceOf([[{ id: 1 }], [{ id: 2 }], []]);
    for await (const _ of streamRowsByKeyset(source, new SqliteDialect(), 'SELECT * FROM "t"', [], 1)) {
      void _;
    }
    expect(executed[0]).toMatch(/LIMIT 1 OFFSET 0/);
    expect(executed[1]).toMatch(/LIMIT 1 OFFSET 1/);
    expect(executed[2]).toMatch(/LIMIT 1 OFFSET 2/);
  });

  it('取消：抛出调用方指定的错误类型', async () => {
    class Cancelled extends Error {}
    const { source } = sourceOf([[{ id: 1 }]]);
    const run = async () => {
      for await (const _ of streamRowsByKeyset(source, new MysqlDialect(), 'SELECT * FROM `t`', ['id'], 1, {
        isCancelled: () => true,
        cancelError: () => new Cancelled('cancelled'),
      })) {
        void _;
      }
    };
    await expect(run()).rejects.toBeInstanceOf(Cancelled);
  });
});