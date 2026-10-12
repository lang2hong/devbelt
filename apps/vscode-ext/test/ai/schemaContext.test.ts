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
    const snapshot = await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false });
    expect(snapshot!.commentCount).toBe(0);
    expect(snapshot!.text).not.toContain('-- 0=禁用');
  });

  it('60s TTL 缓存：重复 build 不重复抓元数据；invalidate 后重抓', async () => {
    const { session, getTables } = makeSession();
    const builder = new AiSchemaContextBuilder();
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true });
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true });
    expect(getTables).toHaveBeenCalledTimes(1);

    builder.invalidate('c1');
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true });
    expect(getTables).toHaveBeenCalledTimes(2);

    // 不同连接/不同 includeComments 各占独立缓存键。
    await builder.build(session, { connId: 'c2', dbType: 'MYSQL', includeComments: true });
    await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false });
    expect(getTables).toHaveBeenCalledTimes(4);
  });

  it('元数据失败 → null（聊天降级为无 schema，不抛错）', async () => {
    const { session } = makeSession({ fail: true });
    const builder = new AiSchemaContextBuilder();
    await expect(builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: true })).resolves.toBeNull();
  });

  it('大库：S3 上限 50 表（S4 换批量查询+预筛），totalTables 反映真实数量', async () => {
    const { session } = makeSession({ tables: 60 });
    const builder = new AiSchemaContextBuilder();
    const snapshot = await builder.build(session, { connId: 'c1', dbType: 'MYSQL', includeComments: false });
    expect(snapshot!.tableCount).toBe(50);
    expect(snapshot!.totalTables).toBe(60);
    expect(snapshot!.truncated).toBe(true);
  });
});