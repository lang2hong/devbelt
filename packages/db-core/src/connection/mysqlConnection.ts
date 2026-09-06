import * as fs from 'fs';
import * as mysql from 'mysql2';
import type { TypeCastField } from 'mysql2';
import { IConnection } from './connection';
import type { ConnectionConfig } from '../types/connection';
import type { QueryCallback } from '../types/query';

/**
 * 类型名与「二进制 or 文本」存在多义的类型。
 *
 * 这些类型**不能用 `field.type` 判定二进制**：MySQL 协议里 BLOB 家族的 type
 * code 同时代表两类 ——
 *   - `BLOB`      = BLOB 与 TEXT
 *   - `TINY_BLOB` = TINYBLOB 与 TINYTEXT
 *   - `MEDIUM_BLOB`= MEDIUMBLOB 与 MEDIUMTEXT
 *   - `LONG_BLOB` = LONGBLOB 与 LONGTEXT
 *   - `STRING`    = CHAR 与 BINARY
 *   - `VAR_STRING`= VARCHAR 与 VARBINARY
 *
 * 真正区分二进制靠**字符集**（characterSet === 63，binary），而这一判断在
 * mysql2 内部已经做好（readCodeFor 的 default 分支：charset 为 BINARY 时返回
 * Buffer，否则按列编码返回 string）。因此这类值直接 `next()` 交给 mysql2，
 * 不在这里用 type 白名单一刀切 —— 一刀切正是「TEXT 被误判成 BLOB、
 * VARBINARY 被误判成 VARCHAR」的根因。
 */
const TEXT_OR_BINARY_TYPES = new Set([
  'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'STRING', 'VAR_STRING',
]);

/** 日期时间类：交给驱动按 dateStrings 处理，不自己转 */
const DATE_TYPES = new Set([
  'DATETIME', 'TIMESTAMP', 'DATE', 'TIME', 'NEWDATE', 'DATETIME2',
]);

/**
 * 连接串里不允许出现的参数。
 *
 * 实测 mysql2：`{ uri: '...?multipleStatements=true', multipleStatements: false }`
 * 最终得到 `multipleStatements === true` —— **URL 里的参数胜出**。也就是说
 * 用户在连接串里写上这一句，多语句执行就打开了，此后任何拼接 SQL 的位置
 * （筛选条件、表名、导入语句）都成了可以塞 `; DROP TABLE ...` 的注入点。
 * 连接串多半是从文档或同事那里复制来的，用户不会意识到自己开了什么。
 */
const FORBIDDEN_URL_PARAMS = ['multipleStatements'];

/**
 * 剥掉连接串里的危险参数，保留其余部分。
 *
 * 精确剥离而不是整段丢弃 query string：`charset`、`timezone` 这些参数是用户
 * 有意设置的，扔掉会改变行为。解析失败时原样返回 —— 让驱动去报它自己的
 * 错误信息，那比我们编一个"URL 格式不对"更有用。
 */
function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    for (const key of FORBIDDEN_URL_PARAMS) {
      // 参数名大小写不敏感地找
      for (const actual of [...url.searchParams.keys()]) {
        if (actual.toLowerCase() === key.toLowerCase()) {
          url.searchParams.delete(actual);
          changed = true;
        }
      }
    }
    if (!changed) return raw;
    // searchParams 为空时 URL.toString() 会留下一个孤零零的 '?'
    const out = url.toString();
    return out.endsWith('?') ? out.slice(0, -1) : out;
  } catch {
    return raw;
  }
}

export class MysqlConnection extends IConnection {
  private con: mysql.Connection;

  constructor(config: ConnectionConfig) {
    super(config);
    this.con = mysql.createConnection(this.buildConfig(config));
  }

  /**
   * 组装驱动配置。
   *
   * 连接串模式走 `uri` 字段而**不是** `createConnection(urlString)`。
   * 后者只用那个 URL，其余选项全部丢弃 —— 丢掉的不是可选优化，是正确性设定：
   *
   *  - `supportBigNumbers` / `bigNumberStrings`：BIGINT 超出 2^53 会被 JS
   *    number 静默截断。id `1234567890123456789` 读出来是
   *    `1234567890123456800`，拿它去 UPDATE 会改错行。
   *  - `dateStrings`：日期变 JS Date，再按本地时区格式化，显示值与库里不一致。
   *  - `typeCast`：BIT 不再转 boolean，二进制列不再保持 Buffer。
   *  - `multipleStatements: false`：URL 模式下由驱动默认值决定。一旦 URL 里
   *    带了 `?multipleStatements=true`，任何拼接 SQL 的地方都变成注入点。
   *  - `ssl` / `connectTimeout`：勾了 SSL 也不生效；连不上时无限等待。
   */
  private buildConfig(config: ConnectionConfig): mysql.ConnectionConfig {
    const conf = {
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: config.connectTimeout || 5000,
      typeCast: (field: TypeCastField, next: () => unknown) => this.castField(field, next),
    } as mysql.ConnectionConfig;

    if (config.useConnectionString && config.connectionUrl) {
      // mysql2 支持 `uri` 与其他选项共存：URL 提供连接目标，其余字段照常生效
      (conf as any).uri = sanitizeUrl(config.connectionUrl);
    } else {
      Object.assign(conf, {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        timezone: config.timezone,
        socketPath: config.socketPath,
      });
    }

    if (config.useSSL) {
      conf.ssl = {
        ca: this.readCert(config.caPath, 'CA certificate'),
        cert: this.readCert(config.clientCertPath, 'client certificate'),
        key: this.readCert(config.clientKeyPath, 'client key'),
        /**
         * TLS 1.2 起步。原值 `'TLSv1'` 明确允许 TLS 1.0/1.1 —— 两者已被
         * RFC 8996 弃用，而 Node 18+ 的默认下限本来就是 TLSv1.2。
         * 也就是说那行代码唯一的效果是主动把安全基线往下调，让降级攻击可行。
         */
        minVersion: 'TLSv1.2',
        // 缺省校验服务端证书；允许上层显式关掉（如自签名测试环境）。
        rejectUnauthorized: config.rejectUnauthorized ?? true,
      };
    }
    return conf;
  }

  /**
   * 读证书文件。读不到就**抛错**，不静默降级。
   *
   * 原实现吞掉异常返回 undefined：路径打错一个字母，双向 TLS 静默退化成
   * 单向，界面上仍显示"已启用 SSL"。CA 读不到时更具误导性 —— 校验回落到
   * 系统根证书，自签名的库连不上，而报错是 "self signed certificate in
   * certificate chain"，把排查方向完全带偏。
   */
  private readCert(path: string | undefined, label: string): Buffer | undefined {
    if (!path) return undefined;
    try {
      return fs.readFileSync(path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read ${label} at "${path}": ${reason}`);
    }
  }

  /** 类型转换：日期交给驱动，二进制保持 Buffer，BIT 转 boolean，其余转字符串 */
  private castField(field: TypeCastField, next: () => unknown): unknown {
    if (field.type === 'BIT') return this.bitToBoolean(field.buffer());
    // GEOMETRY：二进制几何值，保持 Buffer（上层自行解析；不走 next 以避免
    // mysql2 把它解析成 Geometry 对象，改变既有契约）
    if (field.type === 'GEOMETRY') return field.buffer() ?? null;
    // JSON：charset 是 63（binary），但内容是 JSON 文本，必须转字符串。
    if (field.type === 'JSON') return field.buffer()?.toString() ?? null;
    if (DATE_TYPES.has(field.type)) return next();
    // BLOB/TEXT/BINARY/VARBINARY：多义类型交给 mysql2 按 charset 解码，
    // 见 TEXT_OR_BINARY_TYPES 注释 —— 不在这里用 type 判定 binary/text。
    if (TEXT_OR_BINARY_TYPES.has(field.type)) return next();
    return field.buffer()?.toString() ?? null;
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

  /**
   * 中断在途查询：另开一条连接发 `KILL QUERY <threadId>`。
   *
   * 原实现是 `this.con.destroy()` —— 销毁的是**整条共享连接**。一个会话里
   * QueryService / MetadataService / DataService / TableService 共用同一条
   * IConnection（见 connectionManager.buildSession），所以：
   *  - 默认 30 秒的查询超时一到，整条连接就废了。树视图、补全、后续查询
   *    全部失败，用户看到的是"查询超时之后连接莫名坏了"。
   *  - 用户在结果面板点"取消"同样如此。
   *  - destroy 不触发 'end' 事件，`dead` 不会被置位，isAlive() 仍可能返回
   *    true，连接池的健康检查也就不会替换它。
   *
   * `KILL QUERY` 只中断当前语句，连接本身保持可用，这才是取消的语义。
   * 必须另开连接：本连接正被那条查询占着，发不出新语句。
   *
   * 整个过程尽力而为、绝不抛错 —— abortQuery 跑在取消/超时路径上，
   * 它抛错会把"查询已超时"变成"取消的时候又炸了一次"。
   */
  abortQuery(): void {
    const threadId = (this.con as any).threadId;
    if (threadId == null) return;
    try {
      const killer = mysql.createConnection(this.buildConfig(this.config));
      killer.query(`KILL QUERY ${Number(threadId)}`, () => {
        try { killer.end(() => {}); } catch { /* 已经断了 */ }
      });
      killer.on('error', () => { /* 杀不掉就算了，查询侧已经 reject 过 */ });
    } catch { /* 连接都建不起来，无从取消 */ }
  }

  bitToBoolean(buf: Buffer | null): any {
    return buf ? buf[0] === 1 : null;
  }
}
