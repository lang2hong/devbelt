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
        ca: config.caPath ? this.readFileSafe(config.caPath) : undefined,
        cert: config.clientCertPath ? this.readFileSafe(config.clientCertPath) : undefined,
        key: config.clientKeyPath ? this.readFileSafe(config.clientKeyPath) : undefined,
        minVersion: 'TLSv1',
      };
    }
    this.con = mysql.createConnection(conf);
  }

  private readFileSafe(path: string): Buffer | undefined {
    try {
      return fs.readFileSync(path);
    } catch {
      return undefined;
    }
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
    this.con.on('error', () => {
      this.dead = true;
    });
    this.con.on('end', () => {
      this.dead = true;
    });
    this.con.connect(callback);
  }

  beginTransaction(callback: (err: any) => void): void {
    this.con.beginTransaction(callback);
  }

  rollback(): void {
    this.con.rollback((err) => {
      if (err) this.dead = true;
    });
  }

  commit(): void {
    this.con.commit((err) => {
      if (err) this.dead = true;
    });
  }

  end(): void {
    this.dead = true;
    this.con.end(() => {});
  }

  abortQuery(): void {
    this.con.destroy();
  }

  bitToBoolean(buf: Buffer | null): any {
    return buf ? buf[0] === 1 : null;
  }
}