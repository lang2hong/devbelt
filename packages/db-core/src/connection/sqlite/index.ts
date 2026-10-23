import * as child_process from 'child_process';
import { randomBytes } from 'crypto';
import { EOL } from 'os';
import { scanSql } from '../../sql/lexer.js';
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
 *
 * 点命令：查询文本经 stdin 交给 CLI。CLI 在语句边界之后的**下一行**若以 `.` 开头，
 * 会把它当 shell 命令执行（`.shell`/`.system` 执行系统命令，`.output` 写文件，
 * `.open` 换库，`.load` 载扩展）。CLI 判断「语句边界」用的是自己的按行状态机
 * （`#` 开头的行整行跳过、`GO`/`/` 视为结束符、`[...]` 视为标识符），通用 SQL
 * 词法器无法与之精确一致，因此不靠识别字符串来拦截，而是保证发送文本**只有一行**
 * 且首字符不是 `.`（见 toSingleLine）。
 *
 * 只读：`readOnly` 时以 `.open --readonly` 打开，再 `PRAGMA query_only=ON`。
 */
export class SqliteQueryShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteQueryShapeError';
  }
}

/**
 * 把查询改写成单行后再交给 sqlite3 CLI。
 *
 * - 代码中的换行 → 空格；
 * - 字符串 / 引用标识符中的换行 → `'…' || char(10) || '…'`（标识符中的换行直接拒绝）；
 * - `--` 行注释、`/* *\/` 块注释 → 空格。
 *
 * 安全性只依赖最后的断言：输出不含 `\n` / `\r`，且首个非空白字符不是 `.`。
 * 词法识别出错只会让 SQL 语法错误或改变字面量，不会让 CLI 执行点命令。
 */
export function toSingleLine(sql: string): string {
  // The lexer reports `'it''s'` as two adjacent string segments; merge them so the
  // literal is rewritten as one value.
  const segments: Array<{ kind: string; start: number; end: number }> = [];
  for (const seg of scanSql(sql, { hashComment: false, backslashEscapes: false })) {
    const prev = segments[segments.length - 1];
    if (prev && prev.kind === 'string' && seg.kind === 'string' && prev.end === seg.start) prev.end = seg.end;
    else segments.push({ kind: seg.kind, start: seg.start, end: seg.end });
  }
  let out = '';
  let pos = 0;
  for (const seg of segments) {
    out += flatten(sql.slice(pos, seg.start));
    const text = sql.slice(seg.start, seg.end);
    if (seg.kind === 'code' || seg.kind === 'execComment') out += flatten(text);
    else if (seg.kind === 'comment') out += ' ';
    else out += splitLiteral(text);
    pos = seg.end;
  }
  out += flatten(sql.slice(pos));
  if (/[\r\n]/.test(out)) throw new SqliteQueryShapeError('SQLite query must be sent as a single line');
  if (/^\s*\./.test(out)) throw new SqliteQueryShapeError('SQLite query must not start with a sqlite3 shell dot-command');
  return out;
}

function flatten(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

/** 字符串字面量中的换行改写为 `char(10)` / `char(13)` 拼接；非 `'` 引用（标识符）不允许换行。 */
function splitLiteral(text: string): string {
  if (!/[\r\n]/.test(text)) return text;
  if (text[0] !== "'" || text.length < 2 || text[text.length - 1] !== "'") {
    throw new SqliteQueryShapeError('SQLite identifiers and unterminated strings must not contain line breaks');
  }
  const body = text.slice(1, -1);
  const parts = body.split(/(\r\n|\r|\n)/);
  const pieces: string[] = [];
  for (const part of parts) {
    if (part === '\r\n') pieces.push('char(13, 10)');
    else if (part === '\n') pieces.push('char(10)');
    else if (part === '\r') pieces.push('char(13)');
    else pieces.push(`'${part}'`);
  }
  return `(${pieces.join(' || ')})`;
}

/** stdin 写失败后等待进程 'close'（以拿到 stderr 真实错误）的上限。 */
const STDIN_ERROR_GRACE_MS = 2000;

class SQLite {
  public readonly dbPath: string;
  public readonly readOnly: boolean;
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

  constructor(dbPath: string, sqliteCommand?: string, options: { readOnly?: boolean } = {}) {
    this.dbPath = dbPath;
    this.readOnly = options.readOnly === true;
    // 未显式配置 sqliteCommand 时自动探测：系统 sqlite3 →（后续）内置二进制回退。
    // 探测不到则置空，query() 会以「not configured」显式失败，绝不静默返回空结果。
    this.sqliteCommand = sqliteCommand ? validateSqliteCommand(sqliteCommand) : getSqliteBinariesPath();
  }

  /**
   * 常驻 CLI 进程是否仍存活。
   *
   * 连接层的 `isAlive()` 过去只看一个「曾经 connect 成功」的布尔量：进程后来退出
   * （崩溃/被杀）仍报存活，上层复用这条会话时查询才失败。这里按真实进程状态判定。
   */
  isProcessAlive(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null && this.proc.signalCode === null;
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
    let line: string;
    try {
      line = toSingleLine(query);
    } catch (err) {
      return Promise.reject(err);
    }
    const run = this.queue.then(() => this.exec(line), () => this.exec(line));
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
    if (this.isProcessAlive()) {
      return this.proc!;
    }

    // SQLite shell 的 dot-command 参数解析无法表达含单引号的路径：
    // `'.open 'a''b''`、双引号、反斜杠三种写法实测（sqlite 3.45）都会拆词并打开
    // **错误的文件**；含换行/回车还会截断 dot-command。静默打开错误的库比报错更危险，
    // 故在启动子进程前 fail-closed。正常路径（无引号/换行）不受影响。
    if (/['\n\r]/.test(this.dbPath)) {
      throw new Error('SQLite database path must not contain a quote, newline, or carriage return');
    }

    // `.explain off`：sqlite3 CLI 默认拦截 `EXPLAIN QUERY PLAN` 改打印 ASCII 树
    // （`QUERY PLAN\n|--SCAN t`），不走 `.mode tcl`，解析器拿到 0 行 —— SQLite 上的
    // EXPLAIN 面板/AI 优化因此恒为空。关闭后 EQP 按普通结果集返回 id/parent/notused/detail。
    // 只影响 EXPLAIN 的特殊处理，普通 SELECT 输出不变。
    const args = ['-bail', '-header', '-nullvalue', 'NULL', '-cmd', '.explain off', '-cmd', '.mode tcl'];
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
    // stdin 的 EPIPE 先记下、等 close 再结算：`-bail` 下 CLI 报错后立即退出，而驱动在语句后还会写
    // `.print` 标记，于是 EPIPE 可能早于 stderr 的真实错误到达。'close' 在 stdout/stderr 都关闭后
    // 才触发，此时 stderr 已读完，onExit 能用上 SQL 错误而不是 `write EPIPE`。
    let stdinError: Error | undefined;
    proc.on('close', () => {
      if (this.proc === proc) this.onExit(stdinError ?? new Error('sqlite process exited unexpectedly'));
    });
    // 子进程已退出后写 stdin 会异步 emit EPIPE；未处理会冒泡成 unhandled 'error' 事件
    // （使 Vitest/进程判失败），所以必须监听。close 未在合理时间内到达时兜底结算，避免挂起。
    proc.stdin!.on('error', (err: Error) => {
      if (this.proc !== proc || stdinError) return;
      stdinError = err;
      const timer = setTimeout(() => { if (this.proc === proc) this.onExit(err); }, STDIN_ERROR_GRACE_MS);
      timer.unref?.();
    });

    // 写 stdin 规避 unicode 路径问题（见 issues #32, #37）。
    // 先关 echo 再 .open，避免启动噪声混入第一条查询的输出窗口。
    // 路径中的引号/换行已在 spawn 前拒绝，此处可安全单引号包裹。
    proc.stdin!.write(`.echo off${EOL}`);
    proc.stdin!.write(`.open ${this.readOnly ? '--readonly ' : ''}'${this.dbPath}'${EOL}`);
    // query_only 再加一道：拒绝任何修改数据库文件的语句（含 ATTACH 后对附加库的写）。
    if (this.readOnly) proc.stdin!.write(`PRAGMA query_only=ON;${EOL}`);
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