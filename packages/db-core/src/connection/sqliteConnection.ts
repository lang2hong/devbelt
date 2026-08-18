import { EventEmitter } from 'events';
import { IConnection } from './connection';
import { SQLite } from './sqlite';
import type { ConnectionConfig } from '../types/connection';
import type { QueryCallback } from '../types/query';

/**
 * SQLite 连接适配器。
 * 底层使用 sqlite3 CLI 子进程执行查询，上传查询结果按行回调。
 */
export class SqliteConnection extends IConnection {
  private sqlite: SQLite;
  private connected: boolean = false;

  constructor(config: ConnectionConfig, sqliteCommand?: string) {
    super(config);
    this.sqlite = new SQLite(config.dbPath || '', sqliteCommand);
  }

  query(sql: string, callback?: QueryCallback): void | EventEmitter;
  query(sql: string, values: any, callback?: QueryCallback): void | EventEmitter;
  query(sql: string, values?: any, callback?: any) {
    if (!callback && values instanceof Function) {
      callback = values;
      values = undefined;
    }
    const event = new EventEmitter();
    // DML（INSERT/UPDATE/DELETE/REPLACE）追加 SELECT changes()，借同一 CLI 进程
    // 拿到受影响行数：SQLite CLI 的 `.mode tcl` 不回显 changes，导致这些语句的
    // affectedRows 恒缺失、结果面板只会显示「0 行受影响」。DDL/SELECT 不追加。
    //
    // 必须显式用 `;` 分隔两条语句：调用方是否自带结尾分号并不统一
    // （DataService 的 updateCell/deleteRows/insertRow 都不带），拼成
    // `INSERT ... VALUES (1) SELECT changes()` 会让 sqlite3 报
    // `Parse error near "SELECT"` —— SQLite 上的单元格编辑、插入行、删除行
    // 全部失败。先剥掉尾部已有的分号与空白再统一补，两种输入都合法。
    const isDml = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
    const effectiveSql = isDml
      ? `${sql.replace(/[\s;]+$/, '')}; SELECT changes()`
      : sql;
    this.sqlite
      .query(effectiveSql + ';')
      .then((res) => {
        if (isDml) {
          const list = Array.isArray(res) ? res : [res];
          const changesRow = list[list.length - 1]?.rows?.[0];
          const changes = changesRow ? Number(Object.values(changesRow)[0]) : undefined;
          const first = list[0];
          if (callback) callback(null, { rows: first.rows, affectedRows: changes }, first.fields);
          return;
        }
        if (Array.isArray(res)) {
          if (callback) callback(null, res);
        } else if (callback) {
          callback(null, res.rows, res.fields);
        } else {
          for (let i = 1; i <= res.rows.length; i++) {
            const row = res.rows[i - 1];
            event.emit('result', this.convertToDump(row), res.rows.length === i);
          }
        }
      })
      .catch((err) => {
        // 错误只送一次，且只送给真的有人收的地方。
        //
        // 原实现是「callback(err) 之后再 event.emit('error', …)」，两件事都做。
        // 但 Node 的 EventEmitter 在没有 'error' 监听者时会把 emit 的参数**抛出来**
        // （ERR_UNHANDLED_ERROR），而这里位于 promise 的 .catch() 内，抛出的东西
        // 就变成一条无人处理的 promise 拒绝。全仓没有任何调用方监听这个 emitter
        // 的 'error'，于是每一次 SQLite 查询失败都会多出一条未捕获拒绝 ——
        // 尽管调用方已经通过 callback 正常收到并处理了该错误。
        //
        // 表现：扩展宿主里一条来源不明的错误日志；跑在
        // --unhandled-rejections=strict 下的 Node 里则直接让进程退出。
        if (callback) {
          callback(err);
          return;
        }
        // 无 callback 时才走事件通道，并且先确认有人在听
        if (event.listenerCount('error') > 0) {
          event.emit('error', err.message);
        }
      });
    return event;
  }

  connect(callback: (err: any) => void): void {
    if (!this.sqlite.dbPath) {
      callback(new Error('Sqlite db path cannot be null!'));
      return;
    }
    this.sqlite.query('SELECT 1').then(() => {
      this.connected = true;
      callback(null);
    }).catch((err) => {
      callback(new Error(`Failed to open SQLite database: ${err.message}`));
    });
  }

  /**
   * SQLite 不支持跨语句事务：每次 query 起一个独立的 sqlite3 CLI 子进程，
   * 进程退出即隐式提交，随后的 ROLLBACK 落在另一个进程上，什么也回滚不了。
   *
   * 原实现执行 `BEGIN` 后回调 `null`，让调用方以为事务已开启 —— 失败时静默
   * 产生部分写入。这里改为显式失败：需要原子性的调用方必须把整批语句拼成
   * 单条 `BEGIN; …; COMMIT;` 交给一个进程执行（见 importRowsBatched 与
   * BackupService.restore 的 singleStatement 选项）。
   */
  beginTransaction(callback: (err: any) => void): void {
    callback(new Error(
      'SQLite does not support multi-statement transactions through the CLI driver: '
      + 'each query runs in its own process. Send the whole batch as a single '
      + '"BEGIN; ...; COMMIT;" statement instead.',
    ));
  }

  /** no-op：无跨语句事务可回滚（见 beginTransaction） */
  rollback(): void {
    /* intentionally empty */
  }

  /** no-op：无跨语句事务可提交（见 beginTransaction） */
  commit(): void {
    /* intentionally empty */
  }

  end(): void {
    this.connected = false;
    this.sqlite.killAll();
  }

  isAlive(): boolean {
    return this.connected;
  }

  /** Override base class to use SQLite-compatible escaping. */
  convertToDump(row: any): any {
    const out: any = {};
    for (const key in row) {
      const element = row[key];
      if (element == null) {
        out[key] = 'NULL';
      } else if (typeof element === 'string') {
        out[key] = `'${element.replace(/'/g, "''")}'`;
      } else {
        out[key] = String(element);
      }
    }
    return out;
  }
}