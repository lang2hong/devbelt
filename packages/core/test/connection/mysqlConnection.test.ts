import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * MySQL 连接适配器的构造与生命周期。
 *
 * 这里全部用 mock 拦 `mysql2.createConnection`，断言**传给驱动的配置**与
 * **abortQuery 的行为**。理由：这几个缺陷都发生在"配置对不对"层面，
 * 真库连上之后反而看不出来 —— 一条 TLSv1 的 minVersion、一个被静默忽略的
 * 客户端证书，在功能上都表现为"连上了"。
 */

const created: any[] = [];
const fakeConn = () => ({
  state: 'authenticated',
  authorized: true,
  threadId: 4242,
  query: vi.fn(),
  connect: vi.fn(),
  on: vi.fn(),
  end: vi.fn((cb?: any) => cb?.()),
  destroy: vi.fn(),
  beginTransaction: vi.fn(),
  rollback: vi.fn(),
  commit: vi.fn(),
});

vi.mock('mysql2', () => ({
  createConnection: (conf: any) => {
    if ((globalThis as any).__forceCreateFail) throw new Error('cannot connect');
    const c = fakeConn();
    created.push({ conf, con: c });
    return c;
  },
}));

// mock 必须在 import 之前生效，故用动态 import
const { MysqlConnection } = await import('../../src/connection/mysqlConnection');

const readFile = vi.hoisted(() => ({ impl: null as null | ((p: string) => Buffer) }));
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>();
  return {
    ...real,
    readFileSync: (p: any, ...rest: any[]) => {
      if (readFile.impl && typeof p === 'string') return readFile.impl(p);
      return (real.readFileSync as any)(p, ...rest);
    },
  };
});

beforeEach(() => { created.length = 0; readFile.impl = null; });
afterEach(() => { vi.restoreAllMocks(); });

const base = { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' };

describe('连接串模式', () => {
  /**
   * 连接串模式此前是 `mysql.createConnection(config.connectionUrl)` —— 只用那个
   * URL，其余选项**全部丢弃**。丢掉的不是可选优化，是正确性设定：
   *  - `supportBigNumbers` / `bigNumberStrings`：BIGINT 超出 2^53 时被 JS
   *    number 静默截断。id 1234567890123456789 读出来变 1234567890123456800，
   *    拿它去 UPDATE 会改错行。
   *  - `dateStrings`：日期变成 JS Date，再按本地时区格式化 —— 显示的时间与
   *    库里的值不一致。
   *  - `typeCast`：BIT 不再转 boolean。
   *  - `multipleStatements: false`：URL 模式下由驱动默认值决定，而一旦哪天
   *    默认值变化或 URL 里带了 `?multipleStatements=true`，SQL 注入的门就开了。
   *  - `ssl` / `connectTimeout`：勾了 SSL 也不生效，连不上时无限等待。
   */
  it('连接串模式仍然应用精度、日期与安全选项', () => {
    new MysqlConnection({ ...base, useConnectionString: true, connectionUrl: 'mysql://a:b@c:3306/d' });
    expect(created).toHaveLength(1);
    const { conf } = created[0];
    expect(typeof conf).toBe('object');
    expect(conf.uri ?? conf.connectionString).toBe('mysql://a:b@c:3306/d');
    expect(conf.supportBigNumbers).toBe(true);
    expect(conf.bigNumberStrings).toBe(true);
    expect(conf.dateStrings).toBe(true);
    expect(conf.multipleStatements).toBe(false);
    expect(typeof conf.typeCast).toBe('function');
  });

  /**
   * URL 查询参数不能覆盖安全设定。
   *
   * 实测 mysql2：`{ uri: '...?multipleStatements=true', multipleStatements: false }`
   * 最终得到 `multipleStatements = true` —— URL 里的参数胜出。也就是说用户
   * 在连接串里写上这一句，就把多语句执行打开了，此后任何拼接 SQL 的地方
   * （筛选条件、表名、导入语句）都变成一个可以塞 `; DROP TABLE` 的注入点。
   * 连接串通常是从别处复制粘贴来的，用户不会意识到自己开了什么。
   */
  it('连接串里的 multipleStatements=true 被剥掉', () => {
    new MysqlConnection({
      ...base, useConnectionString: true,
      connectionUrl: 'mysql://a:b@c:3306/d?multipleStatements=true&charset=utf8mb4',
    });
    const { conf } = created[0];
    const uri = String(conf.uri ?? conf.connectionString ?? '');
    expect(uri).not.toMatch(/multipleStatements/i);
    // 其他参数要保留 —— 剥离必须是精确的，不能把整个 query string 扔掉
    expect(uri).toMatch(/charset=utf8mb4/);
    expect(conf.multipleStatements).toBe(false);
  });

  it('连接串不含查询参数时原样传递', () => {
    new MysqlConnection({
      ...base, useConnectionString: true, connectionUrl: 'mysql://a:b@c:3306/d',
    });
    expect(String(created[0].conf.uri)).toBe('mysql://a:b@c:3306/d');
  });

  it('连接串无法解析时原样传给驱动（让驱动报它自己的错）', () => {
    new MysqlConnection({
      ...base, useConnectionString: true, connectionUrl: 'not a url',
    });
    expect(String(created[0].conf.uri)).toBe('not a url');
  });

  it('连接串模式也应用 SSL 设置', () => {
    readFile.impl = () => Buffer.from('CA');
    new MysqlConnection({
      ...base, useConnectionString: true, connectionUrl: 'mysql://a:b@c:3306/d',
      useSSL: true, caPath: '/tmp/ca.pem',
    });
    const { conf } = created[0];
    expect(conf.ssl).toBeTruthy();
    expect(conf.ssl.ca?.toString()).toBe('CA');
  });
});

describe('TLS 配置', () => {
  /**
   * `minVersion: 'TLSv1'` 明确允许 TLS 1.0/1.1。这两个版本已被 RFC 8996 弃用，
   * 且 Node 18+ 默认最低就是 TLSv1.2 —— 也就是说这行代码是**主动把安全基线
   * 往下调**，唯一效果是让降级攻击可行。
   */
  it('minVersion 至少是 TLSv1.2', () => {
    new MysqlConnection({ ...base, useSSL: true });
    const { conf } = created[0];
    expect(conf.ssl.minVersion).toBe('TLSv1.2');
  });

  /**
   * 证书读不到必须报错，不能静默降级。
   *
   * 原实现 `readFileSafe` 吞掉异常返回 undefined：路径打错一个字母，
   * 双向 TLS 静默退化成单向，用户界面上仍显示"已启用 SSL"。CA 读不到时
   * 更糟 —— 校验回落到系统根证书，自签名的库直接连不上，而报错是
   * "self signed certificate"，指向完全错误的方向。
   */
  it('CA 路径读取失败时抛错而不是静默忽略', () => {
    readFile.impl = () => { throw new Error('ENOENT'); };
    expect(() => new MysqlConnection({ ...base, useSSL: true, caPath: '/nope/ca.pem' }))
      .toThrow(/ca.*\/nope\/ca\.pem|\/nope\/ca\.pem/i);
  });

  it('客户端证书读取失败时抛错', () => {
    readFile.impl = () => { throw new Error('EACCES'); };
    expect(() => new MysqlConnection({ ...base, useSSL: true, clientCertPath: '/nope/c.pem' }))
      .toThrow(/\/nope\/c\.pem/);
  });

  it('未配置证书路径时不报错（单向 TLS 是合法配置）', () => {
    expect(() => new MysqlConnection({ ...base, useSSL: true })).not.toThrow();
    expect(created[0].conf.ssl.ca).toBeUndefined();
  });
});

describe('typeCast', () => {
  function castOf() {
    new MysqlConnection({ ...base });
    return created[0].conf.typeCast as (f: any, next: () => unknown) => unknown;
  }

  const field = (type: string, buf: Buffer | null) => ({ type, buffer: () => buf });

  /**
   * BLOB / TEXT / BINARY / VARBINARY 是「二进制 or 文本」多义类型。
   *
   * MySQL 协议里 `BLOB`=BLOB/TEXT、`STRING`=CHAR/BINARY、`VAR_STRING`=VARCHAR/VARBINARY
   * 共享 type code，真正区分二进制靠列的 characterSet（63=binary），而这一区分
   * mysql2 已在内部做对（text_parser 的 readCodeFor）。因此这些类型直接委托给
   * next()，不在这里用 type 白名单一刀切 —— 一刀切正是「TEXT 被误判成 Buffer、
   * SHOW COLUMNS 的 Type/Comment 等元数据文本列渲染成 {"type":"Buffer"}」的根因。
   */
  it('BLOB/TEXT/BINARY/VARBINARY 委托给 next（由 mysql2 按 charset 判定）', () => {
    const cast = castOf();
    for (const t of ['BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'STRING', 'VAR_STRING']) {
      expect(cast(field(t, Buffer.from('x')), () => 'NEXT')).toBe('NEXT');
    }
  });

  /**
   * GEOMETRY 保持 Buffer，不委托 next —— next 会把它解析成 Geometry 对象，
   * 改变既有契约（上层拿到的是 Buffer）。
   */
  it('GEOMETRY 保持 Buffer', () => {
    const cast = castOf();
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
    expect(cast(field('GEOMETRY', raw), () => 'NEXT')).toBe(raw);
  });

  /** JSON 列 charset 是 binary，但内容是 JSON 文本，必须转字符串。 */
  it('JSON 转字符串', () => {
    const cast = castOf();
    expect(cast(field('JSON', Buffer.from('{"a":1}')), () => 'NEXT')).toBe('{"a":1}');
  });

  it('日期时间类交给驱动处理（dateStrings 生效）', () => {
    const cast = castOf();
    for (const t of ['DATETIME', 'TIMESTAMP', 'DATE', 'TIME', 'NEWDATE', 'DATETIME2']) {
      expect(cast(field(t, Buffer.from('x')), () => 'NEXT')).toBe('NEXT');
    }
  });

  it('BIT 仍转 boolean', () => {
    const cast = castOf();
    expect(cast(field('BIT', Buffer.from([1])), () => 'NEXT')).toBe(true);
    expect(cast(field('BIT', Buffer.from([0])), () => 'NEXT')).toBe(false);
  });

  /** 数值等其它类型仍转字符串（保持 numeric→string 现状，不漂移）。 */
  it('数值等其它类型转字符串', () => {
    const cast = castOf();
    for (const t of ['LONG', 'TINY', 'FLOAT', 'DOUBLE', 'NEWDECIMAL']) {
      expect(cast(field(t, Buffer.from('123')), () => 'NEXT')).toBe('123');
    }
    expect(cast(field('LONG', null), () => 'NEXT')).toBe(null);
  });
});

describe('abortQuery 不销毁共享连接', () => {
  /**
   * 一个连接会话里 QueryService / MetadataService / DataService / TableService
   * **共用同一条 IConnection**（见 connectionManager.buildSession）。
   * 原实现 `abortQuery()` 直接 `con.destroy()`：
   *  - 默认 30 秒的查询超时会触发它 —— 一条慢查询超时，整条连接就废了，
   *    树视图、后续查询全部失败，用户看到的是"超时之后连接坏了要重连"。
   *  - 用户在结果面板点"取消"同理。
   *  - 而且 destroy 之后 `dead` 没被置位，isAlive() 还可能返回 true，
   *    连接池的健康检查不会替换它。
   *
   * MySQL 取消查询的正确方式是**另开一条连接发 `KILL QUERY <threadId>`**：
   * 服务端中断那条语句，连接本身保持可用。
   */
  it('取消时发 KILL QUERY 而不是 destroy 本连接', () => {
    const c = new MysqlConnection({ ...base });
    const { con } = created[0];
    created.length = 0;

    c.abortQuery();

    expect(con.destroy).not.toHaveBeenCalled();
    // 另开了一条连接
    expect(created).toHaveLength(1);
    const killer = created[0];
    expect(killer.conf.host).toBe('h');
    // 那条连接上执行 KILL QUERY <threadId>
    const sqls = killer.con.query.mock.calls.map((a: any[]) => String(a[0]));
    expect(sqls.some((s: string) => /KILL\s+QUERY\s+4242/i.test(s))).toBe(true);
  });

  it('KILL 用完即关，不泄漏连接', () => {
    const c = new MysqlConnection({ ...base });
    created.length = 0;
    c.abortQuery();
    const killer = created[0].con;
    // query 的回调里 end
    const cb = killer.query.mock.calls[0][1];
    if (typeof cb === 'function') cb(null);
    expect(killer.end).toHaveBeenCalled();
  });

  it('拿不到 threadId 时不发 KILL，也不销毁连接', () => {
    const c = new MysqlConnection({ ...base });
    created[0].con.threadId = null;
    created.length = 0;
    expect(() => c.abortQuery()).not.toThrow();
    expect(created).toHaveLength(0);
  });

  /**
   * KILL 自身失败不能冒泡：abortQuery 是取消路径，它抛错会把
   * "查询已超时" 变成 "取消时又炸了一次"。
   */
  it('KILL 连接建立失败不抛出', () => {
    const c = new MysqlConnection({ ...base });
    created.length = 0;
    // 让后续 createConnection 抛错
    const original = (globalThis as any).__forceCreateFail;
    (globalThis as any).__forceCreateFail = true;
    try {
      expect(() => c.abortQuery()).not.toThrow();
    } finally {
      (globalThis as any).__forceCreateFail = original;
    }
  });

  it('end() 之后标记 dead', () => {
    const c = new MysqlConnection({ ...base });
    c.end();
    expect(c.isAlive()).toBe(false);
  });
});
