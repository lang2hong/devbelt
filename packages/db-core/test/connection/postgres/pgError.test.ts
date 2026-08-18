import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { PostgreSqlConnection } from '../../../src/connection/postgreSqlConnection';

/**
 * query() 失败路径的进程安全性（与 sqliteError.test.ts 同一类缺陷，但更严重）。
 *
 * 原实现在出错时两件事都做：先 `callback(err)`，再 `event.emit('error', …)`。
 * Node 的 EventEmitter 在没有 'error' 监听者时会把 emit 的参数**抛出来**
 * （ERR_UNHANDLED_ERROR），而全仓没有任何调用方监听这个 emitter 的 'error'
 * —— 所以每一次 PostgreSQL 查询失败都会多抛一次，尽管调用方已经通过 callback
 * 正常收到并处理了该错误。触发条件极其普通：一条 SQL 写错表名就够了。
 *
 * ## 为什么这条比 sqlite 那条严重
 *
 * 抛出的位置不同，Node 的归类也就不同：
 *
 *   sqlite   —— emit 在 promise 的 .catch() 里 → unhandledRejection（一条日志）
 *   postgres —— emit 在 pg 驱动的同步 callback 里 → uncaughtException（进程退出）
 *
 * VS Code 扩展宿主自己装了 uncaughtException handler，所以在扩展里不会真崩；
 * 但那是靠宿主兜着。任何在扩展之外复用 db-core 的场景（CLI、脚本、服务端）
 * 都会被一条写错的 SQL 直接打死。
 *
 * 这里注入桩 client，不依赖真实 PostgreSQL —— 待测的是错误转发逻辑本身。
 */

/** 造一个「驱动回调必然带 err」的连接 */
function failingConnection(message = 'relation "t" does not exist'): PostgreSqlConnection {
  const conn = new PostgreSqlConnection({ host: 'x', port: 5432 } as any);
  (conn as any).client = {
    // pg 的 query(sql, [values], cb)：最后一个参数是回调，异步触发
    query: (...args: any[]) => {
      const cb = args[args.length - 1];
      setImmediate(() => cb(new Error(message)));
    },
  };
  return conn;
}

/**
 * 捕获 fn 执行期间的 uncaughtException 与 unhandledRejection。
 *
 * uncaughtException 必须临时接管：不接管的话 vitest 的 worker 会被这个异常
 * 打断，测试结果变成「进程挂掉」而不是「断言失败」，看不出发生了什么。
 */
async function collectFatal(fn: () => Promise<void>): Promise<unknown[]> {
  const caught: unknown[] = [];
  const onUncaught = (e: unknown) => { caught.push(e); };
  const onUnhandled = (e: unknown) => { caught.push(e); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // 上报是异步的，多等几轮宏任务
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  }
  return caught;
}

const describeErrors = (list: unknown[]): string =>
  list.map((e) => (e instanceof Error ? `${(e as any).code ?? ''} ${e.message}` : String(e))).join(' | ');

describe('PostgreSqlConnection query 失败路径', () => {
  it('带 callback 时错误只走 callback，不产生 uncaughtException', async () => {
    const conn = failingConnection();
    let cbErr: any;

    const fatal = await collectFatal(async () => {
      await new Promise<void>((resolve) => {
        conn.query('SELECT * FROM t', (err: any) => { cbErr = err; resolve(); });
      });
    });

    expect(cbErr, 'callback 必须收到错误').toBeTruthy();
    expect(cbErr.message).toContain('relation');
    expect(fatal, `产生了致命异常：${describeErrors(fatal)}`).toEqual([]);
  });

  it('带 values 数组的参数化查询同样不产生致命异常', async () => {
    const conn = failingConnection('syntax error at or near "$1"');
    let cbErr: any;

    const fatal = await collectFatal(async () => {
      await new Promise<void>((resolve) => {
        conn.query('SELECT * FROM t WHERE id = $1', [1], (err: any) => { cbErr = err; resolve(); });
      });
    });

    expect(cbErr).toBeTruthy();
    expect(fatal, `产生了致命异常：${describeErrors(fatal)}`).toEqual([]);
  });

  it('无 callback 但有 error 监听者时，监听者仍然收到错误', async () => {
    const conn = failingConnection('boom');
    const ev = conn.query('SELECT * FROM t') as unknown as EventEmitter;
    expect(ev).toBeInstanceOf(EventEmitter);

    const msg = await new Promise<unknown>((resolve, reject) => {
      ev.on('error', resolve);
      setTimeout(() => reject(new Error('error 事件没有触发')), 2000);
    });
    expect(String(msg)).toContain('boom');
  });

  /**
   * 没有 callback、也没有 error 监听者 —— 谁都不关心这个错误。
   * 这种情况下 emit 只会打死进程，不发才是对的。
   */
  it('无 callback 且无 error 监听者时静默丢弃，不打死进程', async () => {
    const fatal = await collectFatal(async () => {
      const conn = failingConnection();
      conn.query('SELECT * FROM t');
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(fatal, `产生了致命异常：${describeErrors(fatal)}`).toEqual([]);
  });

  it('成功路径不受影响：SELECT 经 callback 拿到行与字段', async () => {
    const conn = new PostgreSqlConnection({ host: 'x', port: 5432 } as any);
    (conn as any).client = {
      query: (...args: any[]) => {
        const cb = args[args.length - 1];
        setImmediate(() => cb(null, { command: 'SELECT', rows: [{ one: 1 }], fields: [{ name: 'one' }] }));
      },
    };

    const out = await new Promise<any>((resolve, reject) => {
      conn.query('SELECT 1 AS one', (err: any, rows: any, fields: any) =>
        (err ? reject(err) : resolve({ rows, fields })));
    });

    expect(out.rows).toEqual([{ one: 1 }]);
    expect(out.fields).toEqual([{ name: 'one' }]);
  });

  it('成功路径不受影响：DML 经 callback 拿到 affectedRows', async () => {
    const conn = new PostgreSqlConnection({ host: 'x', port: 5432 } as any);
    (conn as any).client = {
      query: (...args: any[]) => {
        const cb = args[args.length - 1];
        setImmediate(() => cb(null, { command: 'UPDATE', rowCount: 2, rows: [], fields: [] }));
      },
    };

    const res = await new Promise<any>((resolve, reject) => {
      conn.query('UPDATE t SET a = 1', (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });

    expect(res.affectedRows).toBe(2);
  });

  /**
   * 无 callback 的成功路径走 'result' 事件流。
   * 这条确认修复没有把正常的事件通道一起改坏。
   */
  it('成功路径不受影响：无 callback 时通过 result 事件流出行', async () => {
    const conn = new PostgreSqlConnection({ host: 'x', port: 5432 } as any);
    (conn as any).client = {
      query: (...args: any[]) => {
        const cb = args[args.length - 1];
        setImmediate(() => cb(null, { command: 'SELECT', rows: [{ a: 1 }, { a: 2 }], fields: [] }));
      },
    };

    const ev = conn.query('SELECT a FROM t') as unknown as EventEmitter;
    const rows: any[] = [];
    await new Promise<void>((resolve) => {
      ev.on('result', (row: any, isLast: boolean) => {
        rows.push(row);
        if (isLast) resolve();
      });
    });

    expect(rows).toHaveLength(2);
  });
});
