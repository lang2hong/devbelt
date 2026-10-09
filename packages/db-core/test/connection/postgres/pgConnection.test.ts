import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * PostgreSQL 连接适配器的构造与取消。
 *
 * 与 MySQL 侧同理：这些缺陷都在"配置对不对"和"取消到底做了什么"层面，
 * 真库连上之后从功能上看不出来。
 */
const created: any[] = [];

const fakeClient = () => ({
  processID: 7788,
  query: vi.fn(),
  connect: vi.fn(),
  on: vi.fn(),
  end: vi.fn(() => Promise.resolve()),
});

vi.mock('pg', () => {
  class Client {
    constructor(public conf: any) {
      if ((globalThis as any).__pgForceFail) throw new Error('cannot construct');
      const c = fakeClient();
      created.push({ conf, client: c });
      Object.assign(this, c);
    }
  }
  return {
    default: { types: { setTypeParser: vi.fn() }, Client },
    Client,
    types: { setTypeParser: vi.fn() },
  };
});

const { PostgreSqlConnection } = await import('../../../src/connection/postgreSqlConnection');

const readFile = vi.hoisted(() => ({ impl: null as null | ((p: string) => string) }));
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

const base = { host: 'h', port: 5432, user: 'u', password: 'p', database: 'd' };

describe('连接串模式', () => {
  /**
   * pg 的 `new Client(urlString)` 同样只用那个 URL：`statement_timeout` 与
   * `connectionTimeoutMillis` 被丢弃 —— 连接串模式下查询超时形同虚设，
   * 连不上时也会无限等待。SSL 配置同理不生效。
   */
  it('连接串模式仍应用超时与 SSL', () => {
    readFile.impl = () => 'CA';
    new PostgreSqlConnection({
      ...base, useConnectionString: true, connectionUrl: 'postgres://a:b@c:5432/d',
      connectTimeout: 3000, requestTimeout: 9000, useSSL: true, caPath: '/tmp/ca.pem',
    });
    const { conf } = created[0];
    expect(typeof conf).toBe('object');
    expect(conf.connectionString).toBe('postgres://a:b@c:5432/d');
    expect(conf.connectionTimeoutMillis).toBe(3000);
    expect(conf.statement_timeout).toBe(9000);
    expect(conf.ssl.ca).toBe('CA');
  });
});

describe('TLS 配置', () => {
  it('证书读取失败时抛错', () => {
    readFile.impl = () => { throw new Error('ENOENT'); };
    expect(() => new PostgreSqlConnection({ ...base, useSSL: true, caPath: '/nope/ca.pem' }))
      .toThrow(/\/nope\/ca\.pem/);
  });

  it('minVersion 至少 TLSv1.2', () => {
    new PostgreSqlConnection({ ...base, useSSL: true });
    expect(created[0].conf.ssl.minVersion).toBe('TLSv1.2');
  });

  /**
   * 提供了 CA 就必须验证证书。
   *
   * pg 的默认 `ssl: {}` 在没有 ca 时等价于 `rejectUnauthorized: true`，但显式
   * 写出来更重要的是防止将来有人"为了能连上"顺手加个 false —— 那样 SSL 只
   * 剩加密没有认证，中间人可以随意冒充数据库。
   */
  it('显式开启证书校验', () => {
    readFile.impl = () => 'CA';
    new PostgreSqlConnection({ ...base, useSSL: true, caPath: '/tmp/ca.pem' });
    expect(created[0].conf.ssl.rejectUnauthorized).toBe(true);
  });
});

describe('abortQuery', () => {
  /**
   * PG 侧此前**完全没有实现** abortQuery（继承基类的空实现）。
   *
   * 后果是取消与超时只在客户端生效：QueryService 把 promise reject 掉，
   * 界面显示"已取消"，但那条语句在服务端仍在跑 —— 一个全表扫的
   * `SELECT count(*)` 会继续占着 CPU 和 IO 到自然结束。用户点了取消、
   * 甚至关掉了面板，数据库还在为它工作。反复触发就是把库压垮。
   *
   * PG 的取消方式是另开连接执行 `pg_cancel_backend(pid)`。
   * 和 MySQL 侧一样：绝不销毁本连接（会话内四个服务共用它），绝不抛错。
   */
  it('另开连接执行 pg_cancel_backend，不动本连接', () => {
    const c = new PostgreSqlConnection({ ...base });
    const self = created[0].client;
    created.length = 0;

    c.abortQuery();

    expect(self.end).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    const killer = created[0];
    expect(killer.conf.host).toBe('h');

    // pg 的 Client 必须先 connect 才能 query —— 驱动这里不会自动建连
    expect(killer.client.connect).toHaveBeenCalled();
    killer.client.connect.mock.calls[0][0](null);

    const sqls = killer.client.query.mock.calls.map((a: any[]) => String(a[0]));
    expect(sqls.some((s: string) => /pg_cancel_backend/i.test(s))).toBe(true);
    // pid 走参数化而不是拼进 SQL
    expect(killer.client.query.mock.calls[0][1]).toEqual([7788]);

    // 用完即关，不泄漏连接
    killer.client.query.mock.calls[0][2](null);
    expect(killer.client.end).toHaveBeenCalled();
  });

  it('取消连接建连失败时关掉它，不泄漏', () => {
    const c = new PostgreSqlConnection({ ...base });
    created.length = 0;
    c.abortQuery();
    const killer = created[0];
    killer.client.connect.mock.calls[0][0](new Error('refused'));
    expect(killer.client.query).not.toHaveBeenCalled();
    expect(killer.client.end).toHaveBeenCalled();
  });

  it('拿不到 pid 时什么都不做', () => {
    const c = new PostgreSqlConnection({ ...base });
    (created[0].client as any).processID = null;
    (c as any).client.processID = null;
    created.length = 0;
    expect(() => c.abortQuery()).not.toThrow();
    expect(created).toHaveLength(0);
  });

  it('取消连接自身报错不冒泡', () => {
    const c = new PostgreSqlConnection({ ...base });
    created.length = 0;
    (globalThis as any).__pgForceFail = true;
    try {
      expect(() => c.abortQuery()).not.toThrow();
    } finally {
      (globalThis as any).__pgForceFail = false;
    }
  });
});

describe('convertToDump (PG 转义)', () => {
  it('只翻倍单引号，不翻倍反斜杠（standard_conforming_strings=on）', () => {
    const c = new PostgreSqlConnection({ ...base });
    expect(c.convertToDump({ a: 'C:\\tmp', b: "O'Brien", n: null, i: 42 }))
      .toEqual({ a: "'C:\\tmp'", b: "'O''Brien'", n: 'NULL', i: '42' });
  });
});

describe('adaptResult (RETURNING 行不得丢失)', () => {
  it('INSERT/UPDATE/DELETE 带 RETURNING 时同时带出 affectedRows 与 rows', () => {
    const c = new PostgreSqlConnection({ ...base });
    expect(c.adaptResult({ command: 'INSERT', rowCount: 2, rows: [{ id: 1 }, { id: 2 }] } as any))
      .toEqual({ affectedRows: 2, rows: [{ id: 1 }, { id: 2 }] });
  });

  it('无 RETURNING 的 DML：rows 为空数组，affectedRows 保留', () => {
    const c = new PostgreSqlConnection({ ...base });
    expect(c.adaptResult({ command: 'UPDATE', rowCount: 3, rows: [] } as any))
      .toEqual({ affectedRows: 3, rows: [] });
  });

  it('SELECT 仍返回行数组', () => {
    const c = new PostgreSqlConnection({ ...base });
    expect(c.adaptResult({ command: 'SELECT', rowCount: 1, rows: [{ a: 1 }] } as any)).toEqual([{ a: 1 }]);
  });
});

describe('schema / socketPath / timezone', () => {
  it('schema 与 timezone 通过启动参数生效，socketPath 作为 host 目录', () => {
    new PostgreSqlConnection({
      ...base,
      host: 'ignored-by-socket',
      schema: 'myschema',
      timezone: 'Asia/Shanghai',
      socketPath: '/var/run/postgresql/.s.PGSQL.5432',
    } as any);
    const { conf } = created[0];
    expect(conf.host).toBe('/var/run/postgresql');
    // A6：schema 名按标识符规则加双引号（内嵌引号翻倍）后作为 search_path 生效。
    expect(conf.options).toContain('-c search_path="myschema"');
    expect(conf.options).toContain('-c TimeZone=Asia/Shanghai');
  });

  it('socketPath 已是目录时原样使用；特殊 schema 加引号，控制字符 schema 被忽略', () => {
    new PostgreSqlConnection({
      ...base,
      socketPath: '/var/run/postgresql',
      schema: 'bad name',
      timezone: 'Asia/Shanghai; DROP',
    } as any);
    const { conf } = created[0];
    expect(conf.host).toBe('/var/run/postgresql');
    // 含空格的合法 schema：加双引号后作为 search_path 生效。
    expect(conf.options).toBe('-c search_path="bad name"');
    // timezone 仍按安全字符白名单：含空格/分号被忽略。
    expect(conf.options).not.toContain('TimeZone');
  });
});
