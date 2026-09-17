import * as child_process from 'child_process';
import { randomBytes } from 'crypto';
import { EOL } from 'os';
import { ResultSetParser } from './resultSetParser.js';
import { validateSqliteCommand, getSqliteBinariesPath } from './sqliteCommandValidation.js';
import type { Result, ResultNew, ResultSet } from './common/index.js';

/**
 * SQLite 驱动封装：通过 **常驻** `sqlite3` CLI 子进程执行查询。
 *
 * 与「每次 query 起一个进程」相比：省掉进程启动开销、消除无上限 spawn；
 * 代价是需要自己给输出做**逐查询定界**——CLI 不会在每条语句后退出。
 *
 * 定界协议：
 *  - 启动：`.echo off` → `.open '<path>'` → `.echo on`（`.open` 不产生 echo 噪声），
 *    并带 `-header -nullvalue NULL -cmd ".mode tcl"`；
 *  - 每条语句后追加 `.print DBDONE<nonce>`（nonce 随机）。`.echo on` 会把该命令
 *    回显为 `.print DBDONE<nonce>`，但其输出行恰为 `DBDONE<nonce>`；
 *  - 以**整行** `DBDONE<nonce>` 作为该查询结束标记，截取其前的输出交给
 *    `ResultSetParser`（保留 `.echo on` 的「回显+结果」原始语义）。
 *
 * 使用 `-bail`：某条语句报错时 CLI **立即中止并退出**，从而保证
 * `BEGIN; …; COMMIT;` 批处理失败即回滚（原子性）；进程退出由 `onExit` 捕获，
 * 用 stderr 文本拒绝在途查询，下一次查询会重建进程。
 *
 * 查询串行化：单连接一次只跑一条语句（promise 队列），避免 stdin/输出交错。
 * 取消/进程崩溃/错误退出：拒绝在途查询并丢弃进程，下次查询重建。
 */
class SQLite {
  public readonly dbPath: string;
  private sqliteCommand?: string;
  private proc?: child_process.ChildProcess;
  /** stdout 累积缓冲：可能跨 chunk、跨查询。 */
  private buffer = '';

  private current?: {
    settle: (err: Error | undefined, result?: ResultNew | ResultNew[]) => void;
    parser: ResultSetParser;
    markerRe: RegExp;
    stderr: string;
  };
  /** 串行队列：保证同一连接的语句不交错。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dbPath: string, sqliteCommand?: string) {
    this.dbPath = dbPath;
    // 未显式配置 sqliteCommand 时自动探测：系统 sqlite3 →（后续）内置二进制回退。
    // 探测不到则置空，query() 会以「not configured」显式失败，绝不静默返回空结果。
    this.sqliteCommand = sqliteCommand ? validateSqliteCommand(sqliteCommand) : getSqliteBinariesPath();
  }

  /** 终止常驻进程并拒绝在途查询（连接关闭/取消时调用）。 */
  killAll(): void {
    this.killProc(new Error('sqlite query cancelled'));
  }

  query(query: string): Promise<ResultNew | ResultNew[]> {
    if (!this.sqliteCommand) {
      return Promise.reject(new Error(
        'sqlite3 command is not configured. '
        + 'Install sqlite3 or set the "sqliteCommand" field on this connection.',
      ));
    }
    const run = this.queue.then(() => this.exec(query), () => this.exec(query));
    this.queue = run.catch(() => {});
    return run;
  }

  private exec(rawQuery: string): Promise<ResultNew | ResultNew[]> {
    let proc: child_process.ChildProcess;
    try {
      proc = this.ensureProc();
    } catch (err) {
      return Promise.reject(err);
    }

    const query = /;\s*$/.test(rawQuery) ? rawQuery : `${rawQuery.replace(/\s*$/, '')};`;
    const nonce = randomBytes(8).toString('hex');
    const marker = `DBDONE${nonce}`;

    return new Promise<ResultNew | ResultNew[]>((resolve, reject) => {
      const settle = (err: Error | undefined, result?: ResultNew | ResultNew[]): void => {
        if (this.current?.settle !== settle) return; // 已被更早的路径结算
        this.current = undefined;
        if (err) reject(err);
        else resolve(result as ResultNew | ResultNew[]);
      };

      this.current = {
        settle,
        parser: new ResultSetParser(),
        markerRe: new RegExp(`(?:^|\\n)(${marker})\\r?\\n`),
        stderr: '',
      };

      try {
        proc.stdin!.write(`${query}${EOL}`);
        proc.stdin!.write(`.print ${marker}${EOL}`);
      } catch (err) {
        settle(err as Error);
      }
    });
  }

  /** 惰性启动/复用常驻进程；启动失败抛错。 */
  private ensureProc(): child_process.ChildProcess {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null && this.proc.signalCode === null) {
      return this.proc;
    }

    const args = ['-bail', '-header', '-nullvalue', 'NULL', '-cmd', '.mode tcl'];
    const proc = child_process.spawn(this.sqliteCommand as string, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 所有事件都按进程身份过滤：进程退出后 onExit 会清 this.proc，但关闭/数据事件可能
    // 迟到；若不判身份，旧进程的 stderr/stdout 会被记到**新查询**的 current 上，
    // 把旧错误（如 -bail 的语法错误）算到后续查询（偶发、随负载显现）。
    proc.stdout!.on('data', (data: Buffer) => {
      if (this.proc === proc) this.onStdout(data.toString());
    });
    proc.stderr!.on('data', (data: Buffer) => {
      if (this.proc === proc && this.current) this.current.stderr += data.toString();
    });
    proc.on('error', (err: Error) => { if (this.proc === proc) this.onExit(err); });
    proc.on('close', () => { if (this.proc === proc) this.onExit(new Error('sqlite process exited unexpectedly')); });
    // 子进程已退出后写 stdin 会异步 emit EPIPE；未处理会冒泡成 unhandled 'error' 事件
    // （使 Vitest/进程判失败）。仅在仍为当前进程时交给 onExit 结算，避免陈旧进程误伤新查询。
    proc.stdin!.on('error', (err: Error) => { if (this.proc === proc) this.onExit(err); });

    // 写 stdin 规避 unicode 路径问题（见 issues #32, #37）。
    const escapedPath = this.dbPath.replace(/'/g, "''");
    // 先关 echo 再 .open，避免启动噪声混入第一条查询的输出窗口。
    proc.stdin!.write(`.echo off${EOL}`);
    proc.stdin!.write(`.open '${escapedPath}'${EOL}`);
    proc.stdin!.write(`.echo on${EOL}`);

    this.proc = proc;
    this.buffer = '';
    return proc;
  }

  private onStdout(data: string): void {
    this.buffer += data;
    const current = this.current;
    if (!current) return;
    const m = current.markerRe.exec(this.buffer);
    if (!m) return;

    const window = this.buffer.slice(0, m.index);
    this.buffer = this.buffer.slice(m.index + m[0].length);

    current.parser.push(window);
    const resultSet = current.parser.done();
    if (current.stderr.trim()) {
      current.settle(new Error(current.stderr.trim()));
      return;
    }
    current.settle(undefined, this.toResultNew(resultSet, window));
  }

  private toResultNew(resultSet: ResultSet | undefined, fallbackStmt: string): ResultNew | ResultNew[] {
    const sets: ResultSet = resultSet ?? [{ stmt: fallbackStmt, rows: [], header: [] }];
    const newResult: ResultNew[] = sets.map((result) => ({
      sql: result.stmt,
      fields: result.header.map((head) => ({ name: head })),
      rows: result.rows.map((row) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < result.header.length; i++) {
          obj[result.header[i]] = row[i];
        }
        return obj;
      }),
    }));
    return newResult.length === 1 ? newResult[0] : newResult;
  }

  private onExit(err: Error): void {
    const proc = this.proc;
    this.proc = undefined;
    this.buffer = '';
    if (proc) {
      try { proc.removeAllListeners(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
    }
    const current = this.current;
    if (!current) return;
    // `-bail` 下失败会直接退出进程：优先用 stderr 的真实 SQL 错误作为原因。
    const message = current.stderr.trim();
    current.settle(message ? new Error(message) : err);
  }

  private killProc(err: Error): void {
    const proc = this.proc;
    this.proc = undefined;
    this.buffer = '';
    if (proc) {
      try { proc.removeAllListeners(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
    }
    if (this.current) this.current.settle(err);
  }
}

export { SQLite, validateSqliteCommand };
export type { Result, ResultNew, ResultSet };
export default SQLite;