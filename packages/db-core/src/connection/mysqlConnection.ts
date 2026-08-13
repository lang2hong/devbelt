import * as fs from 'fs';
import * as mysql from 'mysql2';
import type { TypeCastField } from 'mysql2';
import { IConnection } from './connection';
import type { ConnectionConfig } from '../types/connection';
import type { QueryCallback } from '../types/query';

export class MysqlConnection extends IConnection {
  private con: mysql.Connection;

  constructor(config: ConnectionConfig) {
    super(config);
    if (config.useConnectionString && config.connectionUrl) {
      this.con = mysql.createConnection(config.connectionUrl);
      return;
    }
    const conf = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      timezone: config.timezone,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: config.connectTimeout || 5000,
      socketPath: config.socketPath,
      typeCast: (field: TypeCastField, next: () => unknown) => {
        const t = field.type;
        // 日期时间类型走 mysql2 默认(dateStrings:true → 完整 'YYYY-MM-DD HH:MM:SS')
        if (t === 'DATETIME' || t === 'TIMESTAMP' || t === 'DATE' || t === 'TIME' || t === 'NEWDATE' || t === 'DATETIME2') {
          return next();
        }
        const buf = field.buffer();
        if (field.type === 'BIT') {
          return this.bitToBoolean(buf);
        }
        return buf?.toString() ?? null;
      },
    } as mysql.ConnectionConfig;
    if (config.useSSL) {
      conf.ssl = {
        rejectUnauthorized: false,
        ca: config.caPath ? fs.readFileSync(config.caPath) : undefined,
        cert: config.clientCertPath ? fs.readFileSync(config.clientCertPath) : undefined,
        key: config.clientKeyPath ? fs.readFileSync(config.clientKeyPath) : undefined,
        minVersion: 'TLSv1',
      };
    }
    this.con = mysql.createConnection(conf);
  }

  isAlive(): boolean {
    return !this.dead && (this.con.state === 'authenticated' || this.con.authorized);
  }

  query(sql: string, callback?: QueryCallback): void;
  query(sql: string, values: any, callback?: QueryCallback): void;
  query(sql: any, values?: any, callback?: any) {
    return this.con.query(sql, values, callback);
  }

  connect(callback: (err: any) => void): void {
    this.con.connect(callback);
    this.con.on('error', () => {
      this.dead = true;
    });
    this.con.on('end', () => {
      this.dead = true;
    });
  }

  beginTransaction(callback: (err: any) => void): void {
    this.con.beginTransaction(callback);
  }

  rollback(): void {
    this.con.rollback(() => {});
  }

  commit(): void {
    this.con.commit();
  }

  end(): void {
    this.dead = true;
    this.con.end(() => {});
  }

  abortQuery(): void {
    this.dead = true;
    this.con.destroy();
  }

  bitToBoolean(buf: Buffer | null): any {
    return buf ? buf[0] === 1 : null;
  }
}