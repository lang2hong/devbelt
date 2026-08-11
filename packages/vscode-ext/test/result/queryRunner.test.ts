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

  it('cancel 在无运行查询时安全返回', () => {
    const manager: any = { connect: async () => ({}), disposeConn: vi.fn() };
    const { runner } = makeRunner(manager);
    expect(() => runner.cancel()).not.toThrow();
  });
});