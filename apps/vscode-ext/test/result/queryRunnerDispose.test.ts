import { describe, expect, it, vi } from 'vitest';
import { QueryRunner } from '../../src/result/queryRunner';

vi.mock('vscode', () => ({ window: { showErrorMessage: () => {}, showWarningMessage: async () => 'Run SQL' } }));

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n', readOnly: false, environment: 'development' };

/**
 * dispose 路径的连接泄漏回归测试。
 *
 * 曾用 `manager.connectSql()` 只为发一条 ROLLBACK。视图 onDispose 的顺序是
 * `runner.dispose()` → `manager.disposeConn()`，同步部分先释放会话，随后
 * microtask 里那个 connectSql 又建了一条无人持有的新连接（带 SSH 隧道一起漏），
 * 每关一个表预览面板泄漏一条。修复后只对已存在会话发 ROLLBACK。
 */
describe('QueryRunner.dispose 连接生命周期', () => {
  it('不调用 connectSql（避免在会话释放后重建连接）', async () => {
    const connectSql = vi.fn(async () => ({}));
    const manager: any = { connectSql, peekSql: () => undefined, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});

    runner.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(connectSql).not.toHaveBeenCalled();
  });

  it('未开启事务时 dispose 不回滚（保护共享会话中的他人事务）', () => {
    const query = vi.fn(async () => ({ rows: [], fields: [] }));
    const manager: any = {
      connectSql: vi.fn(async () => ({})),
      peekSql: () => ({ query: { query } }),
      disposeConn: () => {},
    };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});

    runner.dispose();

    expect(query).not.toHaveBeenCalled();
    expect(manager.connectSql).not.toHaveBeenCalled();
  });

  it('本面板开启事务后 dispose 才发送 ROLLBACK', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], fields: [] }));
    const session: any = {
      query: { query, wrap: (id: string) => `\`${id}\``, cancel: () => true },
      metadata: { getColumns: async () => [] },
    };
    const manager: any = {
      connectSql: vi.fn(async () => session),
      peekSql: () => session,
      disposeConn: () => {},
    };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});

    await runner.execute('BEGIN');
    query.mockClear();
    manager.connectSql.mockClear();
    runner.dispose();

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(manager.connectSql).not.toHaveBeenCalled();
  });

  it('H2：MySQL 精确库键落空时回退主会话发送 ROLLBACK', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], fields: [] }));
    const primary: any = {
      query: { query, wrap: (id: string) => `\`${id}\``, cancel: () => true },
      metadata: { getColumns: async () => [] },
    };
    // 模拟真实 manager：MySQL 会话条目 database 恒为 undefined，按 'shop' 查落空，裸 id 命中主会话。
    const peekSql = vi.fn((_id: string, db?: string) => (db === undefined ? primary : undefined));
    const manager: any = { connectSql: vi.fn(async () => primary), peekSql, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, 'users', 'shop', () => {});

    await runner.execute('BEGIN');
    query.mockClear();
    runner.dispose();

    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('H2：PG 精确库键命中衍生会话时不回退主会话', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], fields: [] }));
    const derived: any = {
      query: { query, wrap: (id: string) => `"${id}"`, cancel: () => true },
      metadata: { getColumns: async () => [] },
    };
    const pgConn: any = { ...conn, dbType: 'PG' };
    const peekSql = vi.fn((_id: string, db?: string) => (db === 'other' ? derived : undefined));
    const manager: any = { connectSql: vi.fn(async () => derived), peekSql, disposeConn: () => {} };
    const runner = new QueryRunner(pgConn, manager, 'users', 'other', () => {});

    await runner.execute('BEGIN');
    query.mockClear();
    runner.dispose();

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    // 不回退裸 id：PG 主会话可能属于其它面板/编辑器，误回滚会丢他人事务。
    expect(peekSql).not.toHaveBeenCalledWith('c1');
  });

  it('无会话时静默跳过 ROLLBACK', () => {
    const manager: any = { connectSql: vi.fn(), peekSql: () => undefined, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});
    expect(() => runner.dispose()).not.toThrow();
  });

  it('ROLLBACK 失败不抛出（best-effort）', async () => {
    const manager: any = {
      connectSql: vi.fn(),
      peekSql: () => ({ query: { query: async () => { throw new Error('gone'); } } }),
      disposeConn: () => {},
    };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});
    expect(() => runner.dispose()).not.toThrow();
    await Promise.resolve();
  });

  it('查询模式（无表）不发 ROLLBACK 也不 peekSql', () => {
    const peekSql = vi.fn();
    const manager: any = { connectSql: vi.fn(), peekSql, disposeConn: () => {} };
    const runner = new QueryRunner(conn, manager, undefined, 'test', () => {});
    runner.dispose();
    expect(peekSql).not.toHaveBeenCalled();
  });

  it('dispose 后 execute 不再触达数据库', async () => {
    const connectSql = vi.fn(async () => ({}));
    const manager: any = { connectSql, peekSql: () => undefined, disposeConn: () => {} };
    const posted: any[] = [];
    const runner = new QueryRunner(conn, manager, 'users', 'test', (m) => posted.push(m));

    runner.dispose();
    await runner.execute('SELECT 1');

    expect(connectSql).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });
});
