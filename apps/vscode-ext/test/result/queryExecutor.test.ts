import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
  window: {
    showWarningMessage: vi.fn(async () => 'Run SQL'),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    createOutputChannel: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dispose: vi.fn() }),
  },
}));

import { QueryExecutor } from '../../src/result/queryExecutor';
import { TableQueryView } from '../../src/result/tableQueryView';

const conn: any = { id: 'c1', name: 'n', dbType: 'MYSQL', host: 'h', port: 3306, environment: 'development', readOnly: false };

function makeManager(queryResult?: any, rejectWith?: Error) {
  const query = {
    query: vi.fn(async () => {
      if (rejectWith) throw rejectWith;
      return queryResult ?? { fields: [{ name: 'id' }], rows: [{ id: 1 }] };
    }),
    wrap: (s: string) => s,
    cancel: () => true,
  };
  const connectSql = vi.fn(async () => ({ query, metadata: { getColumns: async () => [] } }));
  const manager: any = { connectSql, scanOptionsFor: () => undefined, disposeConn: () => {} };
  return { manager, connectSql };
}

describe('QueryExecutor.runHeadless（AI Chat 在对话中运行）', () => {
  it('SELECT 成功：返回结果与耗时，无 error', async () => {
    const { manager } = makeManager();
    const exec = new QueryExecutor(manager);
    const r = await exec.runHeadless(conn, 'SELECT 1', 'db');
    expect(r.error).toBeUndefined();
    expect(r.canceled).toBeUndefined();
    expect(r.result).toMatchObject({ fields: [{ name: 'id' }], rows: [{ id: 1 }] });
    expect(typeof r.costTime).toBe('number');
  });

  it('用户取消（只读连接写语句）→ canceled，不执行', async () => {
    const { manager, connectSql } = makeManager();
    const exec = new QueryExecutor(manager, undefined, undefined);
    const readOnly: any = { ...conn, readOnly: true };
    const r = await exec.runHeadless(readOnly, 'UPDATE t SET x = 1', 'db');
    expect(r.canceled).toBe(true);
    expect(r.result).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(connectSql).not.toHaveBeenCalled();
  });

  it('执行失败：返回 error（不抛）', async () => {
    const { manager } = makeManager(undefined, new Error('Unknown column x'));
    const exec = new QueryExecutor(manager);
    const r = await exec.runHeadless(conn, 'SELECT bogus', 'db');
    expect(r.error?.message).toBe('Unknown column x');
    expect(r.result).toBeUndefined();
  });

  it('写语句无结果集：result 为 fields 空的结果对象', async () => {
    const { manager } = makeManager({ fields: [], rows: [] });
    const exec = new QueryExecutor(manager);
    const r = await exec.runHeadless(conn, 'UPDATE t SET x = 1', 'db');
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.result?.fields)).toBe(true);
    expect(r.result?.fields).toHaveLength(0);
  });

  it('用户取消：句柄 cancel 后返回 userCanceled，不记结果', async () => {
    let rejectQuery: (e: Error) => void = () => {};
    const query = {
      query: vi.fn(() => new Promise((_res, rej) => { rejectQuery = rej; })),
      wrap: (s: string) => s,
      cancel: () => true,
    };
    const manager: any = {
      connectSql: vi.fn(async () => ({ query, metadata: { getColumns: async () => [] } })),
      scanOptionsFor: () => undefined,
      disposeConn: () => {},
    };
    const exec = new QueryExecutor(manager);
    let handle: { cancel(): void } | undefined;
    const pending = exec.runHeadless(conn, 'SELECT SLEEP(60)', 'db', { onStart: (h) => { handle = h; } });
    await vi.waitFor(() => expect(query.query).toHaveBeenCalled());
    handle!.cancel();
    rejectQuery(new Error('Query cancelled'));
    const r = await pending;
    expect(r.userCanceled).toBe(true);
    expect(r.canceled).toBe(true);
    expect(r.result).toBeUndefined();
  });

  it('开跑前取消：不下发查询', async () => {
    const { manager } = makeManager();
    const exec = new QueryExecutor(manager);
    const r = await exec.runHeadless(conn, 'SELECT 1', 'db', { onStart: (h) => h.cancel() });
    expect(r.userCanceled).toBe(true);
    expect(manager.connectSql).not.toHaveBeenCalled();
  });
});

describe('QueryExecutor 历史耗时取驱动实测值', () => {
  it('runHeadless 成功：历史与返回值用驱动耗时', async () => {
    const { manager } = makeManager({ fields: [{ name: 'id' }], rows: [{ id: 1 }], costTime: 1234 });
    const add = vi.fn(async () => undefined);
    const exec = new QueryExecutor(manager, { add } as any);
    const r = await exec.runHeadless(conn, 'SELECT 1', 'db');
    expect(r.costTime).toBe(1234);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ costTime: 1234, sql: 'SELECT 1' }));
  });

  it('runHeadless 失败：历史用 QueryError.costTime', async () => {
    const { manager } = makeManager(undefined, Object.assign(new Error('Unknown column x'), { costTime: 321 }));
    const add = vi.fn(async () => undefined);
    const exec = new QueryExecutor(manager, { add } as any);
    const r = await exec.runHeadless(conn, 'SELECT bogus', 'db');
    expect(r.costTime).toBe(321);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ costTime: 321, failed: true }));
  });

  it('run：回调带 execMs 时用它，不用从命令开始的墙钟时间', async () => {
    let cb: any;
    const spy = vi.spyOn(TableQueryView, 'openForQuery').mockImplementation(async (...args: any[]) => {
      cb = args[4];
      return {} as any;
    });
    const add = vi.fn(async () => undefined);
    const exec = new QueryExecutor({ scanOptionsFor: () => undefined } as any, { add } as any);
    await exec.run(conn, 'SELECT 1', 'db');
    await new Promise((r) => setTimeout(r, 30));
    await cb({ rows: [{ id: 1 }] }, undefined, 5);
    expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ costTime: 5 }));

    await cb(undefined, new Error('x'), 7);
    expect(add).toHaveBeenLastCalledWith(expect.objectContaining({ costTime: 7, failed: true }));

    await cb({ rows: [] }, undefined, undefined);
    const fallback = (add.mock.calls.at(-1) as any[])[0].costTime;
    expect(fallback).toBeGreaterThanOrEqual(30);
    spy.mockRestore();
  });
});
