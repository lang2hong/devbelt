import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as pg from 'pg';
import { IConnection } from './connection';
import type { ConnectionConfig } from '../types/connection';
import type { QueryCallback } from '../types/query';

export class PostgreSqlConnection extends IConnection {
  private client: pg.Client;
  private connected = false;

  constructor(config: ConnectionConfig) {
    super(config);
    if (config.useConnectionString && config.connectionUrl) {
      this.client = new pg.Client(config.connectionUrl);
      return;
    }
    const conf = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: config.connectTimeout || 5000,
      statement_timeout: config.requestTimeout || undefined,
    } as pg.ClientConfig;
    if (config.useSSL) {
      conf.ssl = {
        ca: config.caPath ? this.readFileSafe(config.caPath) : undefined,
        cert: config.clientCertPath ? this.readFileSafe(config.clientCertPath) : undefined,
        key: config.clientKeyPath ? this.readFileSafe(config.clientKeyPath) : undefined,
      };
    }
    this.client = new pg.Client(conf);
  }

  private readFileSafe(path: string): string | undefined {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  isAlive(): boolean {
    return !this.dead && this.connected;
  }

  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: any, values?: any, callback?: any) {
    if (!callback && values instanceof Function) {
      callback = values;
      values = undefined;
    }
    const event = new EventEmitter();
    const queryArgs: any[] = [sql];
    if (Array.isArray(values)) queryArgs.push(values);
    queryArgs.push((err: any, res: any) => {
      if (err) {
        // 错误只送一次，且只送给真的有人收的地方。
        //
        // 原实现是「callback(err) 之后再 event.emit('error', …)」，两件事都做。
        // 但 Node 的 EventEmitter 在没有 'error' 监听者时会把 emit 的参数
        // **抛出来**（ERR_UNHANDLED_ERROR）。全仓没有任何调用方监听这个
        // emitter 的 'error'，于是每一次查询失败都会多抛一次 —— 尽管调用方
        // 已经通过 callback 正常收到并处理了该错误。一条写错表名的 SQL 就够。
        //
        // 这条比 sqliteConnection 里的同类缺陷更严重，因为抛出位置不同：
        //   sqlite   —— emit 在 promise 的 .catch() 里 → unhandledRejection（日志）
        //   这里     —— emit 在 pg 驱动的同步回调里   → uncaughtException（进程退出）
        // VS Code 扩展宿主自带 uncaughtException handler 所以扩展里不会真崩，
        // 但那是靠宿主兜着；db-core 被扩展之外的场景复用时会直接被打死。
        if (callback) {
          callback(err);
          return;
        }
        // 无 callback 时才走事件通道，并且先确认有人在听
        if (event.listenerCount('error') > 0) {
          event.emit('error', err.message);
        }
      } else if (!callback) {
        if (res.rows.length === 0) {
          event.emit('end');
        }
        for (let i = 1; i <= res.rows.length; i++) {
          const row = res.rows[i - 1];
          event.emit('result', this.convertToDump(row), res.rows.length === i);
        }
      } else {
        if (res instanceof Array) {
          callback(null, res.map((row) => this.adaptResult(row)), res.map((row) => row.fields));
        } else {
          callback(null, this.adaptResult(res), res.fields);
        }
      }
    });
    (this.client.query as any)(...queryArgs);
    return event;
  }

  adaptResult(res: pg.QueryArrayResult<any>) {
    if (res.command === 'DELETE' || res.command === 'UPDATE' || res.command === 'INSERT') {
      return { affectedRows: res.rowCount };
    }
    return res.rows;
  }

  connect(callback: (err: any) => void): void {
    this.client.on('error', () => this.end());
    this.client.on('end', () => this.end());
    this.client.connect((err: any) => {
      if (err) { callback(err); return; }
      this.connected = true;
      callback(null);
    });
  }

  async beginTransaction(callback: (err: Error) => void) {
    this.client.query('BEGIN', callback);
  }

  async rollback() {
    await this.client.query('ROLLBACK');
  }

  async commit() {
    await this.client.query('COMMIT');
  }

  end(): void {
    if (this.dead) return;
    this.dead = true;
    this.connected = false;
    this.client.end().catch(() => {});
  }

  /** Override base class to use PG-compatible escaping instead of MySQL-specific sqlstring.escape */
  convertToDump(row: any): any {
    const out: any = {};
    for (const key in row) {
      const element = row[key];
      if (element == null) {
        out[key] = 'NULL';
      } else if (typeof element === 'string') {
        out[key] = `'${element.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
      } else {
        out[key] = String(element);
      }
    }
    return out;
  }
}

/**
 * 将日期/JSON 原样返回，避免 driver 转换
 */
pg.types.setTypeParser(1114, (val) => val); // TIMESTAMP
pg.types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ
pg.types.setTypeParser(1082, (val) => val); // DATE
pg.types.setTypeParser(114, (val) => val); // JSON
pg.types.setTypeParser(3802, (val) => val); // JSONB