import { EventEmitter } from 'events';
import * as fs from 'fs';
import { Client, ClientConfig, QueryArrayResult, types } from 'pg';
import { IConnection } from './connection';
import type { ConnectionConfig } from '../types/connection';
import type { QueryCallback } from '../types/query';

export class PostgreSqlConnection extends IConnection {
  private client: Client;
  private connected = false;

  constructor(config: ConnectionConfig) {
    super(config);
    if (config.useConnectionString && config.connectionUrl) {
      this.client = new Client(config.connectionUrl);
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
    } as ClientConfig;
    if (config.useSSL) {
      conf.ssl = {
        rejectUnauthorized: false,
        ca: config.caPath ? fs.readFileSync(config.caPath) : undefined,
        cert: config.clientCertPath ? fs.readFileSync(config.clientCertPath) : undefined,
        key: config.clientKeyPath ? fs.readFileSync(config.clientKeyPath) : undefined,
      };
    }
    this.client = new Client(conf);
  }

  isAlive(): boolean {
    return !this.dead && this.connected;
  }

  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: any, values?: any, callback?: any) {
    if (!callback && values instanceof Function) {
      callback = values;
    }
    const event = new EventEmitter();
    this.client.query(sql, (err: any, res) => {
      if (err) {
        if (callback) callback(err);
        event.emit('error', err.message);
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
    return event;
  }

  adaptResult(res: QueryArrayResult<any>) {
    if (res.command === 'DELETE' || res.command === 'UPDATE' || res.command === 'INSERT') {
      return { affectedRows: res.rowCount };
    }
    return res.rows;
  }

  connect(callback: (err: any) => void): void {
    this.client.connect((err: any) => {
      callback(err);
      if (!err) {
        this.connected = true;
        this.client.on('error', () => this.end());
        this.client.on('end', () => this.end());
      }
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
    this.client.end();
  }
}

// 保持日期/JSON 原样返回，避免 driver 转换
types.setTypeParser(1114, (val) => val); // TIMESTAMP
types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ
types.setTypeParser(1082, (val) => val); // DATE
types.setTypeParser(114, (val) => val); // JSON
types.setTypeParser(3802, (val) => val); // JSONB