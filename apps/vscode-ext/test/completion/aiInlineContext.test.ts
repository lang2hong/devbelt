import { describe, expect, it } from 'vitest';
import type { ForeignKeyMeta } from '@devbelt/db-core';
import {
  INLINE_TOKEN_BUDGET,
  buildLightSchema,
  collectReferenceTables,
  expandAdjacency,
  estimateSchemaTokens,
  loadLightSchema,
} from '../../src/completion/aiInlineContext';

describe('collectReferenceTables（复用词法器）', () => {
  it('FROM 表 + JOIN/别名值；原文大小写保留、小写去重', () => {
    const refs = collectReferenceTables('SELECT * FROM Orders o JOIN order_items i ON i.order_id = o.id WHERE ');
    expect(refs.map((r) => r.key)).toEqual(['orders', 'order_items']);
    expect(refs[0].raw).toBe('Orders');
  });

  it('反引号包裹的表名去引号', () => {
    const refs = collectReferenceTables('SELECT * FROM `my_orders` WHERE x = 1');
    expect(refs.map((r) => r.raw)).toEqual(['my_orders']);
  });

  it('无 FROM 语句返回空', () => {
    expect(collectReferenceTables('SELECT 1 + ')).toEqual([]);
  });
});

describe('expandAdjacency（外键一跳）', () => {
  const fks: ForeignKeyMeta[] = [
    { tableName: 'order_items', columnName: 'order_id', refTable: 'Orders', refColumn: 'id' },
    { tableName: 'Orders', columnName: 'user_id', refTable: 'users', refColumn: 'id' },
  ];

  it('引用表在前，邻接表补后；大小写不敏感匹配', () => {
    const refs = collectReferenceTables('SELECT * FROM orders JOIN order_items ON 1=1');
    const expanded = expandAdjacency(refs, fks);
    expect(expanded.map((r) => r.key)).toEqual(['orders', 'order_items', 'users']);
    expect(expanded[2].raw).toBe('users');
  });

  it('邻接上限 6 张表', () => {
    const many: ForeignKeyMeta[] = Array.from({ length: 10 }, (_, i) => ({
      tableName: 't0',
      columnName: `c${i}`,
      refTable: `t${i + 1}`,
      refColumn: 'id',
    }));
    const expanded = expandAdjacency(collectReferenceTables('SELECT * FROM t0'), many);
    expect(expanded.length).toBeLessThanOrEqual(6);
  });
});

describe('buildLightSchema（1.5K 预算裁剪）', () => {
  function bigTable(name: string): { name: string; columns: Array<{ name: string; type: string }> } {
    return {
      name,
      columns: Array.from({ length: 50 }, (_, i) => ({ name: `col_${i}_${'x'.repeat(20)}`, type: 'VARCHAR(255)' })),
    };
  }

  it('小 schema 不裁剪；token 在预算内', () => {
    const light = buildLightSchema([{ name: 't', columns: [{ name: 'id', type: 'INT' }] }], {
      dbType: 'MYSQL',
      database: 'app',
      includeComments: false,
    });
    expect(light.tableCount).toBe(1);
    expect(light.estimatedTokens).toBeLessThanOrEqual(INLINE_TOKEN_BUDGET);
    expect(light.text).toContain('## Table: t');
  });

  it('超预算：从尾部逐表裁剪，头部引用表优先保留', () => {
    const tables = [bigTable('first_ref'), bigTable('second'), bigTable('third'), bigTable('fourth')];
    const light = buildLightSchema(tables, { dbType: 'MYSQL', includeComments: false });
    expect(light.estimatedTokens).toBeLessThanOrEqual(INLINE_TOKEN_BUDGET);
    expect(light.tableCount).toBeLessThan(4);
    expect(light.text).toContain('## Table: first_ref');
    expect(estimateSchemaTokens(light.text)).toBe(light.estimatedTokens);
  });
});

describe('loadLightSchema（已解析会话 + 元数据）', () => {
  function fakeSession(overrides: { fail?: boolean; empty?: boolean } = {}): any {
    return {
      metadata: {
        getForeignKeys: async () => {
          if (overrides.fail) throw new Error('down');
          return [{ tableName: 'order_items', columnName: 'order_id', refTable: 'orders', refColumn: 'id' }];
        },
        getColumns: async (name: string) => {
          if (overrides.fail) throw new Error('down');
          return overrides.empty
            ? []
            : [
                { name: 'id', type: 'BIGINT', isNotNull: true, isPrimary: true, comment: '' },
                ...(name === 'orders'
                  ? [{ name: 'status', type: 'TINYINT', isNotNull: true, isPrimary: false, comment: '0=禁用 1=正常' }]
                  : []),
              ];
        },
      },
    };
  }

  it('装载引用表 + 邻接表；注释透传', async () => {
    const light = await loadLightSchema({
      session: fakeSession(),
      dbType: 'MYSQL',
      database: 'app',
      refs: collectReferenceTables('SELECT * FROM order_items WHERE'),
      includeComments: true,
    });
    expect(light).not.toBeNull();
    expect(light!.text).toContain('## Table: order_items');
    expect(light!.text).toContain('## Table: orders');
    expect(light!.text).toContain('0=禁用 1=正常');
  });

  it('无引用表 / 元数据失败 / 空列 → null（不抛）', async () => {
    await expect(
      loadLightSchema({
        session: fakeSession(),
        dbType: 'MYSQL',
        refs: [],
        includeComments: false,
      }),
    ).resolves.toBeNull();

    await expect(
      loadLightSchema({
        session: fakeSession({ fail: true }),
        dbType: 'MYSQL',
        refs: collectReferenceTables('SELECT * FROM orders'),
        includeComments: false,
      }),
    ).resolves.toBeNull();

    await expect(
      loadLightSchema({
        session: fakeSession({ empty: true }),
        dbType: 'MYSQL',
        refs: collectReferenceTables('SELECT * FROM orders'),
        includeComments: false,
      }),
    ).resolves.toBeNull();
  });
});
