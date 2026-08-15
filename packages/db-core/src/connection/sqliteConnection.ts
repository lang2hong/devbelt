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
    const isDml = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
    const effectiveSql = isDml ? `${sql} SELECT changes()` : sql;
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
        if (callback) callback(err);
        event.emit('error', err.message);
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