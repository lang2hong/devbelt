import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { SqliteConnection } from '../../../src/connection/sqliteConnection';

/**
 * query() 失败路径的进程安全性。
 *
 * query() 有两种用法：传 callback（绝大多数调用方）或用返回的 EventEmitter。
 * 失败时原实现两件事都做 —— 先 `callback(err)`，再 `event.emit('error', ...)`。
 *
 * 问题在 Node 的 EventEmitter 语义：`emit('error')` 在**没有 'error' 监听者**时
 * 会把参数抛出来（`ERR_UNHANDLED_ERROR`）。而这行代码位于 promise 的 `.catch()`
 * 里，抛出的东西变成一条无人处理的 promise 拒绝。全仓没有任何调用方监听这个
 * emitter 的 'error'（已 grep 确认），所以**每一次 SQLite 查询失败**都会产生
 * 一条未捕获拒绝 —— 而调用方明明已经通过 callback 正常收到并处理了那个错误。
 *
 * 在 VS Code 扩展宿主里这表现为一条来源不明的错误日志；跑在
 * `--unhandled-rejections=strict` 下的 Node 里则直接让进程退出。
 *
 * 修复原则：错误只送一次。有 callback 就交给 callback；没有 callback 时才发
 * 事件，且仅在真的有人听的时候发。
 *
 * 这里把底层 SQLite 驱动换成受控的桩，不依赖机器上是否装了 sqlite3 ——
 * 待测的是 SqliteConnection 的错误转发逻辑，不是 CLI 本身。真实 CLI 的行为
 * 由 sqliteTransaction.test.ts 覆盖。
 */

/** 造一个底层驱动必然 reject 的连接 */
function failingConnection(message = 'no such table: t'): SqliteConnection {
  const conn = new SqliteConnection({ dbPath: '/tmp/x.db' } as any);
  (conn as any).sqlite = {
    dbPath: '/tmp/x.db',
    query: () => Promise.reject(new Error(message)),
  };
  return conn;
}

/** 捕获 fn 执行期间进程级的未捕获 promise 拒绝 */
async function collectUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
  const caught: unknown[] = [];
  const onUnhandled = (reason: unknown) => { caught.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // 未捕获拒绝的上报是异步的，多等几轮宏任务
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return caught;
}

const describeUnhandled = (list: unknown[]): string =>
  list.map((e) => (e instanceof Error ? e.message : String(e))).join(' | ');

describe('SqliteConnection query 失败路径', () => {
  it('带 callback 时错误只走 callback，不产生未捕获拒绝', async () => {
    const conn = failingConnection();
    let cbErr: any;

    const unhandled = await collectUnhandled(async () => {
      await new Promise<void>((resolve) => {
        conn.query('SELECT * FROM t', (err: any) => { cbErr = err; resolve(); });
      });
    });

    expect(cbErr, 'callback 必须收到错误').toBeTruthy();
    expect(unhandled, `产生了未捕获拒绝：${describeUnhandled(unhandled)}`).toEqual([]);
  });

  /**
   * DML 走的是 query() 里另一条分支（会追加 `SELECT changes()`），
   * 但失败时汇合到同一个 .catch()。两条都要覆盖。
   */
  it('DML 语句失败同样不产生未捕获拒绝', async () => {
    const conn = failingConnection('syntax error');
    let cbErr: any;

    const unhandled = await collectUnhandled(async () => {
      await new Promise<void>((resolve) => {
        conn.query("INSERT INTO t VALUES(1,'a')", (err: any) => { cbErr = err; resolve(); });
      });
    });

    expect(cbErr).toBeTruthy();
    expect(unhandled, `产生了未捕获拒绝：${describeUnhandled(unhandled)}`).toEqual([]);
  });

  it('无 callback 但有 error 监听者时，监听者仍然收到错误', async () => {
    const conn = failingConnection('boom');
    const ev = conn.query('SELECT * FROM t') as EventEmitter;
    expect(ev).toBeInstanceOf(EventEmitter);

    const msg = await new Promise<unknown>((resolve, reject) => {
      ev.on('error', resolve);
      setTimeout(() => reject(new Error('error 事件没有触发')), 2000);
    });
    expect(String(msg)).toContain('boom');
  });

  /**
   * 没有 callback、也没有 error 监听者 —— 谁都不关心这个错误。
   * 这种情况下发事件只会炸掉进程，不发才是对的。
   */
  it('无 callback 且无 error 监听者时静默丢弃，不炸进程', async () => {
    const unhandled = await collectUnhandled(async () => {
      const conn = failingConnection();
      conn.query('SELECT * FROM t');
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(unhandled, `产生了未捕获拒绝：${describeUnhandled(unhandled)}`).toEqual([]);
  });

  it('成功路径不受影响：callback 拿到结果与字段', async () => {
    const conn = new SqliteConnection({ dbPath: '/tmp/x.db' } as any);
    (conn as any).sqlite = {
      dbPath: '/tmp/x.db',
      query: () => Promise.resolve({ rows: [{ one: 1 }], fields: [{ name: 'one' }] }),
    };

    const out = await new Promise<any>((resolve, reject) => {
      conn.query('SELECT 1 AS one', (err: any, rows: any, fields: any) =>
        (err ? reject(err) : resolve({ rows, fields })));
    });

    expect(out.rows).toEqual([{ one: 1 }]);
    expect(out.fields).toEqual([{ name: 'one' }]);
  });

  it('DML 成功路径仍然回传 affectedRows', async () => {
    const conn = new SqliteConnection({ dbPath: '/tmp/x.db' } as any);
    (conn as any).sqlite = {
      dbPath: '/tmp/x.db',
      // 模拟「DML + SELECT changes()」的两段结果
      query: () => Promise.resolve([
        { rows: [], fields: [] },
        { rows: [{ 'changes()': 3 }], fields: [] },
      ]),
    };

    const out = await new Promise<any>((resolve, reject) => {
      conn.query("UPDATE t SET a=1", (err: any, res: any) => (err ? reject(err) : resolve(res)));
    });

    expect(out.affectedRows).toBe(3);
  });
});
