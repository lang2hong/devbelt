import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as pg from 'pg';
import { IConnection } from './connection.js';
import type { ConnectionConfig } from '../types/connection.js';
import type { QueryCallback } from '../types/query.js';

export class PostgreSqlConnection extends IConnection {
  private client: pg.Client;
  private connected = false;

  constructor(config: ConnectionConfig) {
    super(config);
    this.client = new pg.Client(this.buildConfig(config));
  }

  /**
   * 组装 pg 客户端配置。
   *
   * 连接串走 `connectionString` 字段而**不是** `new pg.Client(urlString)`：
   * 后者只用那个 URL，其余选项全部丢弃 —— `statement_timeout` 没了意味着
   * 连接串模式下查询超时形同虚设（客户端超时后语句仍在服务端跑），
   * `connectionTimeoutMillis` 没了意味着连不上时无限等待，
   * `ssl` 没了意味着界面上勾了 SSL 却在明文传输。
   */
  private buildConfig(config: ConnectionConfig): pg.ClientConfig {
    const conf = {
      connectionTimeoutMillis: config.connectTimeout || 5000,
      statement_timeout: config.requestTimeout || undefined,
    } as pg.ClientConfig;

    if (config.useConnectionString && config.connectionUrl) {
      conf.connectionString = config.connectionUrl;
    } else {
      Object.assign(conf, {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
      });
    }

    if (config.useSSL) {
      conf.ssl = {
        ca: this.readCert(config.caPath, 'CA certificate'),
        cert: this.readCert(config.clientCertPath, 'client certificate'),
        key: this.readCert(config.clientKeyPath, 'client key'),
        /** RFC 8996 已弃用 TLS 1.0/1.1；Node 18+ 默认下限本就是 1.2，显式写出以免被调低 */
        minVersion: 'TLSv1.2',
        /**
         * 默认要求验证证书；允许上层显式关掉（如自签名测试环境）。
         *
         * pg 在没有 ca 时默认已是 true，写出来是为了防止将来有人"为了能连上"
         * 顺手改成 false —— 那样 SSL 只剩加密没有认证，中间人可以随意冒充
         * 数据库，而界面上仍然显示"已启用 SSL"。缺省保持 true 的安全基线。
         */
        rejectUnauthorized: config.rejectUnauthorized ?? true,
      };
    }
    return conf;
  }

  /**
   * 读证书。读不到就抛错，不静默降级。
   *
   * 原实现吞掉异常返回 undefined：路径打错一个字母，双向 TLS 静默退化成
   * 单向，界面仍显示已启用 SSL。CA 读不到时更具误导性 —— 校验回落到系统
   * 根证书，自签名的库连不上，报错是 "self signed certificate"，
   * 把排查方向完全带偏。
   */
  private readCert(path: string | undefined, label: string): string | undefined {
    if (!path) return undefined;
    try {
      return fs.readFileSync(path, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read ${label} at "${path}": ${reason}`);
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

  /**
   * 中断在途查询：另开连接执行 `pg_cancel_backend(pid)`。
   *
   * 此前**完全没有实现**（继承基类的空 abortQuery），于是取消与超时只在
   * 客户端生效：QueryService 把 promise reject 掉，界面显示"已取消"，
   * 而那条语句在服务端仍然在跑 —— 一个全表扫的聚合会继续占着 CPU 和 IO
   * 直到自然结束。用户点了取消、甚至关掉了面板，数据库还在为它工作；
   * 反复触发就是把库压垮。
   *
   * 两条与 MySQL 侧相同的纪律：
   *  - 绝不动本连接。一个会话里 QueryService / MetadataService / DataService /
   *    TableService 共用同一条 IConnection，销毁它等于把整个会话废掉。
   *  - 绝不抛错。abortQuery 跑在取消/超时路径上，它抛错会把"查询已超时"
   *    变成"取消的时候又炸了一次"。
   *
   * pid 走参数化。它虽然来自驱动而非用户输入，但拼进 SQL 是一个不必要的
   * 坏习惯 —— 参数化在这里没有任何代价。
   */
  abortQuery(): void {
    const pid = (this.client as any).processID;
    if (pid == null) return;
    try {
      const killer = new pg.Client(this.buildConfig(this.config));
      killer.on('error', () => { /* 取消失败就算了，查询侧已经 reject 过 */ });
      killer.connect((err: any) => {
        if (err) { killer.end().catch(() => {}); return; }
        killer.query('SELECT pg_cancel_backend($1)', [Number(pid)], () => {
          killer.end().catch(() => {});
        });
      });
    } catch { /* 连接都建不起来，无从取消 */ }
  }

  /** Override base class to use PG-compatible escaping instead of MySQL-specific sqlstring.escape */
  convertToDump(row: any): any {
    const out: any = {};
    for (const key in row) {
      const element = row[key];
      if (element == null) {
        out[key] = 'NULL';
} else if (typeof element === 'string') {
      // PG 默认 standard_conforming_strings=on：反斜杠是普通字符，只有单引号需翻倍。
      // 此前按 MySQL 规则把 `\` 翻倍，会把一个反斜杠写成两个字面反斜杠（数据损坏）。
      out[key] = `'${element.replace(/'/g, "''")}'`;
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