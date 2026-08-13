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

  /** 中断在途查询（默认 no-op；支持取消的连接 override） */
  abortQuery(): void {}

  /** 将行数据转为 dump 格式（NULL / 转义字符串），不修改原始行 */
  convertToDump(row: any): any {
    const out: any = {};
    for (const key in row) {
      const element = row[key];
      out[key] = element == null ? 'NULL' : sqlstring.escape(element);
    }
    return out;
  }
}

export type { QueryCallback, FieldInfo };