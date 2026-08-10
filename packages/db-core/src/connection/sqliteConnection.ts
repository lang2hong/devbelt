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
    }
    const event = new EventEmitter();
    this.sqlite
      .query(sql + ';')
      .then((res) => {
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
    callback(null);
    this.connected = true;
  }

  beginTransaction(callback: (err: any) => void): void {
    callback(null);
  }

  rollback(): void {}

  commit(): void {}

  end(): void {
    this.connected = false;
    this.sqlite.killAll();
  }

  isAlive(): boolean {
    return this.connected;
  }
}