import { EventEmitter } from 'events';
import * as sqlstring from 'sqlstring';
import type { ConnectionConfig } from '../types/connection';
import type { FieldInfo } from '../types/meta';
import type { QueryCallback } from '../types/query';

/**
 * 数据库连接抽象。
 * 从原项目 IConnection 剥离 Node/TreeItem 依赖，仅依赖纯 ConnectionConfig。
 */
export abstract class IConnection {
  public dumpMode: boolean = false;
  public config: ConnectionConfig;
  public dead: boolean = false;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  abstract query(sql: string, callback?: QueryCallback): void | EventEmitter;
  abstract query(sql: string, values: any, callback?: QueryCallback): void | EventEmitter;
  abstract connect(callback: (err: any) => void): void;
  abstract beginTransaction(callback: (err: any) => void): void;
  abstract rollback(): void;
  abstract commit(): void;
  abstract end(): void;
  abstract isAlive(): boolean;

  /** 将行数据转为 dump 格式（NULL / 转义字符串） */
  convertToDump(row: any): any {
    for (const key in row) {
      const element = row[key];
      if (element == null) {
        row[key] = 'NULL';
      } else {
        row[key] = sqlstring.escape(element);
      }
    }
    return row;
  }
}

export type { QueryCallback, FieldInfo };