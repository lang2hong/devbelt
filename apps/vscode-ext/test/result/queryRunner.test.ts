import { describe, expect, it, vi } from 'vitest';
import { QueryRunner } from '../../src/result/queryRunner';

vi.mock('vscode', () => ({ window: { showErrorMessage: () => {}, showWarningMessage: async () => 'Run SQL' } }));

const conn: any = { id: 'c1', database: 'test', dbType: 'MYSQL', host: 'h', name: 'n', readOnly: false, environment: 'development' };

function makeRunner(manager: any): { runner: QueryRunner; posted: any[] } {
  const posted: any[] = [];
  const runner = new QueryRunner(conn, manager, 'users', 'test', (m) => posted.push(m));
  return { runner, posted };
}

describe('QueryRunner', () => {
  it('execute 发送 running → result → finished', async () => {
    const query = { query: async () => ({ rows: [{ id: 1 }], fields: [{ name: 'id' }] }), wrap: (id: string) => `\`${id}\``, cancel: () => true };
    const manager: any = { connect: async () => ({ query, metadata: { getColumns: async () => [] } }), disposeConn: () => {} };
    const { runner, posted } = makeRunner(manager);
    await runner.execute('SELECT * FROM users');
    const types = posted.map((m) => m.type);
    expect(types).toContain('running');
    expect(types).toContain('result');
    expect(types[types.length - 1]).toBe('finished');
  });

  it('查询模式（无表）发送 results 而非 result', async () => {
    const query = { query: async () => ({ rows: [{ n: 1 }], fields: [{ name: 'n' }] }), wrap: (id: string) => `\`${id}\``, cancel: () => true };
    const manager: any = { connect: async () => ({ query, metadata: { getColumns: async () => [] } }), disposeConn: () => {} };
    const posted: any[] = [];
    const runner = new QueryRunner(conn, manager, undefined, 'test', (m) => posted.push(m));
    await runner.execute('SELECT 1');
    expect(posted.map((m) => m.type)).toContain('results');
    expect(posted.some((m) => m.type === 'result')).toBe(false);
  });

  it('buildSelect 反映分页/排序/筛选', () => {
    const manager: any = { connect: async () => ({}), disposeConn: () => {} };
    const { runner } = makeRunner(manager);
    runner.offset = 100;
    runner.sortCol = 'id';
    runner.sortDir = 'ASC';
    runner.filterConditions = [{ column: 'name', op: 'eq', value: 'x' }];
    expect(runner.buildSelect()).toContain('ORDER BY `id` ASC');
    expect(runner.buildSelect()).toContain('LIMIT 100 OFFSET 100');
    expect(runner.buildSelect()).toContain('WHERE `name` =');
  });

  /**
   * 回归：表面板里执行写语句/DDL。
   *
   * 这类语句没有结果集，过去仍被塞进单结果分支渲染为「0 row(s)」，
   * 用户以为没生效；还会白跑一条 COUNT。
   */
  it('表模式执行写语句时走 results 分支并带 affectedRows', async () => {
    const executed: string[] = [];
    const query = {
      query: async (sql: string) => {
        executed.push(sql);
        return { rows: [], fields: [], affectedRows: 3, costTime: 5, sql };
      },
      wrap: (id: string) => `\`${id}\``,
      cancel: () => true,
    };
    const manager: any = { connect: async () => ({ query, metadata: { getColumns: async () => [] } }), disposeConn: () => {} };
    const { runner, posted } = makeRunner(manager);
    await runner.execute("UPDATE users SET name = 'x' WHERE id = 1");

    const results = posted.find((m) => m.type === 'results');
    expect(results).toBeDefined();
    expect(results.results[0].affectedRows).toBe(3);
    expect(posted.some((m) => m.type === 'result')).toBe(false);
    expect(executed.some((sql) => /COUNT/i.test(sql))).toBe(false);
  });

  it('表模式执行写语句不覆盖 lastFields（列布局不该被判定过期）', async () => {
    const query = {
      query: async (sql: string) => (/^SELECT/i.test(sql.trim())
        ? { rows: [{ id: 1 }], fields: [{ name: 'id' }], costTime: 1, sql }
        : { rows: [], fields: [], affectedRows: 1, costTime: 1, sql }),
      wrap: (id: string) => `\`${id}\``,
      cancel: () => true,
    };
    const manager: any = { connect: async () => ({ query, metadata: { getColumns: async () => [{ name: 'id' }] } }), disposeConn: () => {} };
    const { runner } = makeRunner(manager);
    await runner.execute('SELECT * FROM users');
    expect(runner.lastFields).toEqual(['id']);
    await runner.execute('DELETE FROM users WHERE id = 1');
    expect(runner.lastFields).toEqual(['id']);
  });

  it('cancel 在无运行查询时安全返回', () => {
    const manager: any = { connect: async () => ({}), disposeConn: vi.fn() };
    const { runner } = makeRunner(manager);
    expect(() => runner.cancel()).not.toThrow();
  });
});
/**
 * 回归：会话在 SQL 编辑器与多个表面板之间共享。过去 dispose() 无条件下发
 * ROLLBACK，关闭任一表面板就会静默回滚其他面板/编辑器未提交的事务（数据丢失）。
 * 现在只有本面板自己 BEGIN 开启的事务才会被回滚。
 */
describe('QueryRunner.dispose 事务隔离', () => {
  function setup(): { runner: QueryRunner; calls: string[] } {
    const calls: string[] = [];
    const query = {
      query: async (sql: string) => { calls.push(sql); return { rows: [], fields: [] }; },
      wrap: (id: string) => `"${id}"`,
      cancel: () => true,
    };
    const manager: any = {
      connect: async () => ({ query, metadata: { getColumns: async () => [] } }),
      peek: () => ({ query }),
      disposeConn: () => {},
    };
    const runner = new QueryRunner(conn, manager, 'users', 'test', () => {});
    return { runner, calls };
  }

  it('未开启事务时 dispose 不回滚（不误伤共享会话）', async () => {
    const { runner, calls } = setup();
    await runner.execute('UPDATE users SET name = \'x\' WHERE id = 1');
    calls.length = 0;
    runner.dispose();
    expect(calls).toEqual([]);
  });

  it('本面板 BEGIN 后 dispose 回滚自己开启的事务', async () => {
    const { runner, calls } = setup();
    await runner.execute('BEGIN');
    calls.length = 0;
    runner.dispose();
    expect(calls).toContain('ROLLBACK');
  });

  it('本面板 COMMIT 后 dispose 不再回滚', async () => {
    const { runner, calls } = setup();
    await runner.execute('BEGIN');
    await runner.execute('COMMIT');
    calls.length = 0;
    runner.dispose();
    expect(calls).toEqual([]);
  });
});
