import { describe, expect, it, vi } from 'vitest';
import type { SqlConnectionSession } from '../../src/connection/connectionSession';
import { AiSchemaContextBuilder } from '../../src/ai/schemaContext';

function makeSession(overrides: { tables?: number; fail?: boolean } = {}): {
  session: SqlConnectionSession;
  getTables: ReturnType<typeof vi.fn>;
} {
  const tableCount = overrides.tables ?? 3;
  const getTables = vi.fn(async () => {
    if (overrides.fail) throw new Error('metadata down');
    return Array.from({ length: tableCount }, (_, i) => ({ name: `t${i}`, comment: '' }));
  });
  const session = {
    metadata: {
      getTables,
      getColumns: async (name: string) => [
        { name: 'id', type: 'INT', isNotNull: true, isPrimary: true, isUnique: false, comment: '' },
        { name: 'parent_id', type: 'INT', isNotNull: false, isPrimary: false, isUnique: false, comment: '' },
        { name: 'status', type: "ENUM('a','b')", isNotNull: false, isPrimary: false, isUnique: false, comment: '0=禁用 1=正常' },
        ...(name === 't0' ? [] : []),
      ],
      getForeignKeys: async () => [{ tableName: 't0', columnName: 'parent_id', refTable: 't1', refColumn: 'id' }],
    },
  } as unknown as SqlConnectionSession;
  return { session, getTables };
}

describe('AiSchemaContextBuilder（扩展侧薄封装）', () => {
  it('组装快照：表/列/注释计数、FK 映射、dbType 头', async () => {
    const { session } = makeSession();
    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, {
      connId: 'c1',
      dbType: 'MYSQL',
      includeComments: true,
      database: 'app',
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({ connId: 'c1', database: 'app', tableCount: 3, totalTables: 3, truncated: false });
    expect(snapshot!.commentCount).toBe(3); // 每表一条 status 注释
    expect(snapshot!.text).toContain('# Database: MYSQL, database: app');
    expect(snapshot!.text).toContain("- status ENUM('a','b') -- 0=禁用 1=正常");
    expect(snapshot!.text).toContain('- parent_id INT FOREIGN KEY -> t1.id');
  });

  it('includeComments=false → commentCount 0 且不渲染注释', async () => {
    const { session } = makeSession();
    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false, database: 'app' });
    expect(snapshot!.commentCount).toBe(0);
    expect(snapshot!.text).not.toContain('-- 0=禁用');
  });

  it('60s TTL 缓存按元数据键（conn+db+schema）：includeComments/userText 变化不重抓；invalidate 后重抓', async () => {
    const { session, getTables } = makeSession();
    const builder = new AiSchemaContextBuilder();
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true, database: 'app' });
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true, database: 'app' });
    expect(getTables).toHaveBeenCalledTimes(1);

    // 序列化参数变化（注释开关/预筛文本）只影响序列化，不重抓元数据。
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false, userText: '订单', database: 'app' });
    expect(getTables).toHaveBeenCalledTimes(1);

    builder.invalidate('c1');
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true, database: 'app' });
    expect(getTables).toHaveBeenCalledTimes(2);

    // 不同连接独立缓存。
    await builder.build(session, { connId: 'c2', dbType: 'MYSQL', includeComments: true, database: 'app' });
    expect(getTables).toHaveBeenCalledTimes(3);
  });

  it('元数据失败 → null（聊天降级为无 schema，不抛错）', async () => {
    const { session } = makeSession({ fail: true });
    const builder = new AiSchemaContextBuilder();
    await expect(builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true, database: 'app' })).resolves.toBeNull();
  });

  it('大库：>200 表截断（totalTables 反映真实数量）', async () => {
    const { session } = makeSession({ tables: 260 });
    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false, database: 'app' });
    expect(snapshot!.tableCount).toBe(200);
    expect(snapshot!.totalTables).toBe(260);
    expect(snapshot!.truncated).toBe(true);
  });

  it('大库预筛：@引用置顶（截断时保留），关键词命中表置顶', async () => {
    const { session } = makeSession({ tables: 260 });
    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, {
      connId: 'c1',
      dbType: 'MYSQL',
      includeComments: false,
      referencedTables: ['t259'],
      userText: '查询 t250 的数据',
      database: 'app',
    });
    expect(snapshot!.text).toContain('## Table: t259');
    expect(snapshot!.text).toContain('## Table: t250');
    expect(snapshot!.tableCount).toBe(200);
  });

  it('大库预筛：英文关键词命中表名/表注释；无命中保持原序', async () => {
    const tableCount = 260;
    const getTables = vi.fn(async () =>
      Array.from({ length: tableCount }, (_, i) => ({
        name: i === 255 ? 'orders_archive' : `t${i}`,
        comment: i === 250 ? 'customer orders archive' : '',
      })),
    );
    const session = {
      metadata: {
        getTables,
        getColumns: async () => [{ name: 'id', type: 'INT', isNotNull: true, isPrimary: true, isUnique: false, comment: '' }],
        getForeignKeys: async () => [],
      },
    } as unknown as SqlConnectionSession;

    const builder = new AiSchemaContextBuilder();
    // 表名命中（orders_archive）
    const byName = await builder.build(session, {
      connId: 'c1',
      dbType: 'MYSQL',
      includeComments: false,
      userText: 'show me recent orders',
      database: 'app',
    });
    expect(byName!.text).toContain('## Table: orders_archive');

    // 表注释命中（customer orders archive）
    builder.invalidate('c1');
    const byComment = await builder.build(session, {
      connId: 'c1',
      dbType: 'MYSQL',
      includeComments: false,
      userText: 'customer orders',
      database: 'app',
    });
    expect(byComment!.text).toContain('## Table: t250');

    // 无命中 → 保持原序（前 200 张，不含尾部表）
    builder.invalidate('c1');
    const noMatch = await builder.build(session, {
      connId: 'c1',
      dbType: 'MYSQL',
      includeComments: false,
      userText: 'zzzzqqqq',
      database: 'app',
    });
    expect(noMatch!.text).toContain('## Table: t0');
    expect(noMatch!.text).not.toContain('## Table: t259');
  });

  it('MySQL 批量列查询：单条 information_schema（含 ENUM/注释），不再逐表 getColumns', async () => {
    const getColumns = vi.fn(async () => []);
    const query = vi.fn(async () => ({
      rows: [
        { TABLE_NAME: 'orders', COLUMN_NAME: 'id', COLUMN_TYPE: 'BIGINT', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, COLUMN_KEY: 'PRI', COLUMN_COMMENT: '' },
        { TABLE_NAME: 'orders', COLUMN_NAME: 'status', COLUMN_TYPE: "ENUM('pending','paid')", IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'pending', COLUMN_KEY: '', COLUMN_COMMENT: '订单状态；pending=待支付,paid=已支付' },
      ],
    }));
    const session = {
      metadata: {
        getTables: vi.fn(async () => [{ name: 'orders', comment: '' }]),
        getColumns,
        getForeignKeys: vi.fn(async () => []),
      },
      query: { query },
    } as unknown as SqlConnectionSession;

    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, { connId: 'c1', dbType: 'mysql', includeComments: true, database: 'app' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String((query.mock.calls[0] as unknown[])[0])).toContain('information_schema.COLUMNS');
    expect(getColumns).not.toHaveBeenCalled();
    expect(snapshot!.text).toContain("- status ENUM('pending','paid') NOT NULL DEFAULT pending");
    expect(snapshot!.text).toContain('字典值：pending=待支付,paid=已支付');
    expect(snapshot!.commentCount).toBe(1);
  });

  it('MySQL 无库 → null（禁止跨库错上下文；探针实测无过滤会横跨 4 库 75 表）', async () => {
    const { session, getTables } = makeSession();
    const builder = new AiSchemaContextBuilder();
    await expect(builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true })).resolves.toBeNull();
    await expect(builder.build(session, { connId: 'c1', dbType: 'mysql', includeComments: true })).resolves.toBeNull();
    expect(getTables).not.toHaveBeenCalled();
  });

  it('单表列元数据失败 → 跳过该表并标记 partial（不再整包失败）', async () => {
    const session = {
      metadata: {
        getTables: vi.fn(async () => [
          { name: 't0', comment: '' },
          { name: 't1', comment: '' },
        ]),
        getColumns: vi.fn(async (name: string) => {
          if (name === 't1') throw new Error('ER_NO_DB_ERROR');
          return [{ name: 'id', type: 'INT', isNotNull: true, isPrimary: true, isUnique: false, comment: '' }];
        }),
        getForeignKeys: vi.fn(async () => []),
      },
    } as unknown as SqlConnectionSession;
    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false, database: 'app' });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.partial).toBe(true);
    expect(snapshot!.text).toContain('## Table: t0');
    expect(snapshot!.text).not.toContain('## Table: t1');
    expect(snapshot!.tableCount).toBe(1);
    expect(snapshot!.totalTables).toBe(2);
  });
});