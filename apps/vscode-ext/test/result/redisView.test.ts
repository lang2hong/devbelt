import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ audits: [] as any[] }));

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { title: '' };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    dispose(): void { this.onDispose(); }
    reveal(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/auditLogger', () => ({
  AuditLogger: { tryLog: (entry: any) => { h.audits.push(entry); } },
}));

import { RedisView, formatRedisReply, parseSlowlog, redisAuditLine } from '../../src/result/redisView';

const conn: any = { id: 'c1', name: 'r', dbType: 'REDIS', host: 'h', port: 6379, redisDb: 3, readOnly: false };

beforeEach(() => { RedisView.closeAll(); h.audits.length = 0; });

type Send = (name: string, args: string[]) => Promise<unknown>;
type RawArg = string | number | Buffer;
type PanelOrTab = 'keyBrowser' | 'serverStatus' | 'console' | 'slowlog';

function makeView(handler?: Send, db?: number, panelOrTab: PanelOrTab = 'console') {
  const sent: [string, RawArg[]][] = [];
  const record = (name: string, args: RawArg[]): unknown => {
    sent.push([name, args]);
    return handler ? handler(name, args.map(String)) : 'OK';
  };
  const client = {
    sendCommand: async (name: string, args: RawArg[] = []) => record(name, args),
    sendCommandBuffer: async (name: string, args: RawArg[] = []) => record(name, args),
    runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    info: async () => 'redis_version:7.0.0\r\n',
  };
  const manager: any = {
    retain: vi.fn(),
    release: vi.fn(),
    connect: async () => ({ kind: 'redis', client, db: 3, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }),
  };
  // db 显式给出 → 键浏览器；否则按 panelOrTab（兼容旧 'status'→serverStatus）。
  const panel = panelOrTab === 'keyBrowser' || db !== undefined
    ? 'keyBrowser'
    : (panelOrTab === 'serverStatus' ? 'serverStatus' : panelOrTab);
  const view: any = RedisView.open(conn, manager, panel as any, db);
  return { view, sent, manager };
}

function posts(view: any): any[] {
  return (view.post as any).mock.calls.map((c: any[]) => c[0]);
}

async function mount(view: any, sent: unknown[] = []): Promise<void> {
  await view.handleMessage({ type: 'ready' });
  await view.handleMessage({ type: 'ready' });
  (view.post as any).mockClear();
  h.audits.length = 0;
  sent.length = 0;
}

describe('parseSlowlog', () => {
  it('归一化 SLOWLOG GET 回复', () => {
    const raw = [[1, 1700000000, 1500, ['SET', 'k', 'v'], '127.0.0.1:5555', 'app']];
    expect(parseSlowlog(raw)).toEqual([
      { id: 1, timestamp: 1700000000, durationMicros: 1500, command: 'SET k v', clientAddr: '127.0.0.1:5555', clientName: 'app' },
    ]);
  });

  it('非数组/畸形项安全处理', () => {
    expect(parseSlowlog(null)).toEqual([]);
    expect(parseSlowlog('nope')).toEqual([]);
    expect(parseSlowlog([42, 'x'])).toEqual([]);
  });
});

describe('formatRedisReply', () => {
  it('nil / 标量 / 嵌套数组', () => {
    expect(formatRedisReply(null)).toBe('(nil)');
    expect(formatRedisReply(undefined)).toBe('(nil)');
    expect(formatRedisReply('OK')).toBe('OK');
    expect(formatRedisReply(42)).toBe('42');
    expect(formatRedisReply(['a', 'b'])).toBe('[\n  \"a\",\n  \"b\"\n]');
  });

  it('Buffer 按 utf8 文本显示', () => {
    expect(formatRedisReply(Buffer.from('hello'))).toBe('hello');
  });
});

describe('redisAuditLine（P7 §十：审计禁止明文密码）', () => {
  it('AUTH 整段脱敏', () => {
    expect(redisAuditLine('AUTH', ['myuser', 'mypassword'])).toBe('AUTH <redacted> <redacted>');
  });

  it('CONFIG SET / ACL SETUSER 全部值脱敏（含参数名，方向安全）', () => {
    const line = redisAuditLine('CONFIG', ['SET', 'requirepass', 'hunter2']);
    expect(line).toContain('<redacted>');
    expect(line).not.toContain('hunter2');
    expect(redisAuditLine('ACL', ['SETUSER', 'u', '>secretpass'])).not.toContain('secretpass');
  });
});

describe('RedisView CLI 管线与审计', () => {
  beforeEach(() => { h.audits.length = 0; });

  it('危险命令先确认；确认后执行并写脱敏审计', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);

    await view.handleMessage({ type: 'runCommand', id: '1', line: 'CONFIG SET requirepass hunter2' });
    expect(sent).toEqual([]);
    expect(posts(view).some((m) => m.type === 'confirmRequired' && m.command === 'CONFIG SET requirepass hunter2')).toBe(true);

    await view.handleMessage({ type: 'confirmDanger', id: '1', accept: true });
    expect(sent).toEqual([['CONFIG', ['SET', 'requirepass', 'hunter2']]]);
    const res = posts(view).find((m) => m.type === 'commandResult');
    expect(res.ok).toBe(true);
    expect(res.command).toBe('CONFIG SET requirepass hunter2');

    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].sql).toContain('<redacted>');
    expect(JSON.stringify(h.audits)).not.toContain('hunter2');
  });

  it('拒绝确认：不执行、不审计，回取消错误', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);

    await view.handleMessage({ type: 'runCommand', id: '1', line: 'FLUSHALL' });
    await view.handleMessage({ type: 'confirmDanger', id: '1', accept: false });
    expect(sent).toEqual([]);
    expect(h.audits).toHaveLength(0);
    const res = posts(view).find((m) => m.type === 'commandResult');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('确认 id 不匹配：忽略，不执行', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);

    await view.handleMessage({ type: 'runCommand', id: '1', line: 'FLUSHALL' });
    await view.handleMessage({ type: 'confirmDanger', id: '2', accept: true });
    expect(sent).toEqual([]);
    expect(posts(view).some((m) => m.type === 'commandResult')).toBe(false);
  });

  it('只读拦截错误原样透传到结果（RedisClient 切面兜底）', async () => {
    const { view } = makeView(async () => { throw new Error('command blocked in read-only mode: SET'); });
    await mount(view);

    await view.handleMessage({ type: 'runCommand', id: '1', line: 'SET k v' });
    const res = posts(view).find((m) => m.type === 'commandResult');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/read-only/);
  });

  it('空命令不发包，回错误', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);

    await view.handleMessage({ type: 'runCommand', id: '1', line: '   ' });
    expect(sent).toEqual([]);
    expect(posts(view).find((m) => m.type === 'commandResult').ok).toBe(false);
  });

  it('KEYS */GET 只读命令直接出结果，不弹确认', async () => {
    const { view, sent } = makeView(async (n) => (n === 'KEYS' ? ['a', 'b'] : n === 'GET' ? 'v' : 'OK'));
    await mount(view, sent);

    await view.handleMessage({ type: 'runCommand', id: '1', line: 'KEYS *' });
    expect(posts(view).some((m) => m.type === 'confirmRequired')).toBe(false);
    const r1 = posts(view).find((m) => m.type === 'commandResult');
    expect(r1.ok).toBe(true);
    expect(r1.result).toContain('a');
    expect(sent).toContainEqual(['KEYS', ['*']]);

    sent.length = 0;
    await view.handleMessage({ type: 'runCommand', id: '2', line: 'GET k' });
    expect(posts(view).some((m) => m.type === 'confirmRequired')).toBe(false);
    const r2 = posts(view).find((m) => m.type === 'commandResult' && m.id === '2');
    expect(r2.ok).toBe(true);
    expect(r2.result).toBe('v');
    expect(sent).toContainEqual(['GET', ['k']]);
  });
});

describe('RedisView S3 键树/值/编辑', () => {
  const replies: Record<string, unknown> = {
    SCAN: ['0', ['user:1', 'user:2', 'cache:a']],
    TYPE: 'string',
    TTL: -1,
    STRLEN: 3,
    GET: 'val',
    DEL: 1,
    INFO: 'redis_version:7.0.0\r\n# Keyspace\ndb0:keys=3,expires=0,avg_ttl=0\n',
    SLOWLOG: [],
  };
  const handler: Send = async (name) => (name in replies ? replies[name] : 'OK');

  async function mountDb(view: any): Promise<void> {
    // 清在 ready 之前：第二次 ready 会主动推 config/keys/info（清在之后会把它们抹掉）。
    (view.post as any).mockClear();
    h.audits.length = 0;
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
  }

  it('挂载 db 后自动加载键树并按分隔符折叠', async () => {
    const { view } = makeView(handler, 0);
    await mountDb(view);
    const keys = posts(view).find((m) => m.type === 'keys');
    expect(keys).toBeTruthy();
    expect(keys.folders.folders.map((f: any) => f.name)).toEqual(['cache', 'user']);
    expect(keys.scanned).toBe(3);
  });

  it('搜索按包含（模糊）：refreshKeys 用 *query* 作 SCAN MATCH', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'refreshKeys', match: 'user' });
    expect(sent.some(([n, a]) => n === 'SCAN' && a.includes('MATCH') && a.includes('*user*'))).toBe(true);
  });

  it('S5-3：树点键打开（initialKey）→ 就绪后自动加载该键值', async () => {
    const sent: [string, (string | number)[]][] = [];
    const session: any = {
      kind: 'redis', db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {},
      client: {
        sendCommand: async (n: string, a: (string | number)[] = []) => {
          sent.push([n, a]);
          if (n === 'SCAN') return ['0', []];
          if (n === 'TYPE') return 'string';
          if (n === 'TTL') return -1;
          if (n === 'STRLEN') return 3;
          if (n === 'GET') return 'val';
          return 'OK';
        },
        runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
        info: async () => '',
      },
    };
    const manager: any = { retain: vi.fn(), release: vi.fn(), connect: async () => session };
    const view: any = RedisView.open(conn, manager, 'keyBrowser', 0, 'user:1');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    const v = posts(view).find((m) => m.type === 'value');
    expect(v.key).toBe('user:1');
    expect(v.data).toEqual({ kind: 'string', text: 'val', base64: Buffer.from('val').toString('base64'), binary: false, bytes: 3 });
  });

  it('reloadKeys：树侧写操作后重扫键树并刷新当前值', async () => {
    const sent: [string, (string | number)[]][] = [];
    const session: any = {
      kind: 'redis', db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {},
      client: {
        sendCommand: async (n: string, a: (string | number)[] = []) => {
          sent.push([n, a]);
          if (n === 'SCAN') return ['0', []];
          if (n === 'TYPE') return 'string';
          if (n === 'TTL') return -1;
          if (n === 'STRLEN') return 3;
          if (n === 'GET') return 'val';
          return 'OK';
        },
        runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
        info: async () => '',
      },
    };
    const manager: any = { retain: vi.fn(), release: vi.fn(), connect: async () => session };
    const view: any = RedisView.open(conn, manager, 'keyBrowser', 0, 'user:1');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    (view.post as any).mockClear();
    sent.length = 0;
    view.reloadKeys();
    await vi.waitFor(() => {
      expect(posts(view).some((m) => m.type === 'value' && m.key === 'user:1')).toBe(true);
    });
    expect(sent.some(([n]) => n === 'SCAN')).toBe(true);
  });

  it('selectKey 拉取类型化值', async () => {
    const { view } = makeView(handler, 0);
    await mountDb(view);
    await view.handleMessage({ type: 'selectKey', key: 'user:1' });
    const v = posts(view).find((m) => m.type === 'value');
    expect(v.keyType).toBe('string');
    expect(v.data).toEqual({ kind: 'string', text: 'val', base64: Buffer.from('val').toString('base64'), binary: false, bytes: 3 });
    expect(v.ttl).toBe(-1);
  });

  it('selectKey 二进制 string：按原始字节下发 base64/binary/bytes', async () => {
    const bin = Buffer.from([0x00, 0xff, 0x41]);
    const binHandler: Send = async (name) => {
      if (name === 'TYPE') return 'string';
      if (name === 'TTL') return -1;
      if (name === 'STRLEN') return bin.length;
      if (name === 'GET') return bin;
      return 'OK';
    };
    const { view } = makeView(binHandler, 0);
    await mountDb(view);
    await view.handleMessage({ type: 'selectKey', key: 'bin' });
    const v = posts(view).find((m) => m.type === 'value');
    expect(v.data).toEqual({
      kind: 'string',
      text: bin.toString('utf8'),
      base64: bin.toString('base64'),
      binary: true,
      bytes: 3,
    });
  });

  it('saveStringBytes：以原始字节 SET、审计 key（不含值）', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    const bytes = Buffer.from([0x00, 0xff, 0x80]);
    await view.handleMessage({ type: 'saveStringBytes', key: 'k', base64: bytes.toString('base64') });
    const set = sent.find(([n]) => n === 'SET');
    expect(set?.[1][0]).toBe('k');
    expect(Buffer.isBuffer(set?.[1][1])).toBe(true);
    expect((set?.[1][1] as Buffer).equals(bytes)).toBe(true);
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);
    expect(h.audits[0].sql).toBe('SET k');
    expect(JSON.stringify(h.audits)).not.toContain(bytes.toString('base64'));
  });

  it('saveString 发包、审计(不含值)、回 keyAction', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'saveString', key: 'user:1', value: 'new-secret-value' });
    expect(sent.some(([n]) => n === 'SET')).toBe(true);
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].sql).toBe('SET user:1');
    expect(JSON.stringify(h.audits)).not.toContain('new-secret-value');
  });

  it('deleteKeys 走 UNLINK 并审计', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'deleteKeys', keys: ['a', 'b'] });
    const unlink = sent.find(([n]) => n === 'UNLINK');
    expect(unlink?.[1]).toEqual(['a', 'b']);
    expect(h.audits[0].sql).toBe('UNLINK a b');
  });

  it('大 key 门禁：超过 1MB 不拉内容', async () => {
    const big: Record<string, unknown> = { ...replies, STRLEN: 2 * 1024 * 1024 };
    const { view } = makeView(async (n) => (n in big ? big[n] : 'OK'), 0);
    await mountDb(view);
    await view.handleMessage({ type: 'selectKey', key: 'user:1' });
    const v = posts(view).find((m) => m.type === 'value');
    expect(v.tooLarge).toBe(true);
    expect(v.data).toBeNull();
  });

  it('renameKey 发包并审计', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'renameKey', key: 'user:1', newKey: 'user:9' });
    expect(sent.some(([n]) => n === 'RENAME')).toBe(true);
    expect(h.audits[0].sql).toBe('RENAME user:1');
  });
});

describe('RedisView S3 回归（提交前评审）', () => {
  it('SELECT 不泄漏：db 视图关闭后，连接级视图归一到 conn.redisDb', async () => {
    const sent: [string, string[]][] = [];
    const session: any = {
      kind: 'redis', db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {},
      client: {
        sendCommand: async (n: string, a: string[] = []) => {
          sent.push([n, a]);
          if (n === 'SCAN') return ['0', []];
          if (n === 'INFO') return '';
          if (n === 'SLOWLOG') return [];
          return 'OK';
        },
        runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
        info: async () => '',
      },
    };
    const manager: any = { retain: vi.fn(), release: vi.fn(), connect: async () => session };
    const connNoDb: any = { id: 'c1', name: 'r', dbType: 'REDIS', host: 'h', port: 6379 };

    const v1: any = RedisView.open(connNoDb, manager, 'keyBrowser', 2);
    await v1.handleMessage({ type: 'ready' });
    await v1.handleMessage({ type: 'ready' });
    expect(sent.some(([n, a]) => n === 'SELECT' && a.join() === '2')).toBe(true);
    expect(session.db).toBe(2);

    sent.length = 0;
    v1.dispose();
    const v2: any = RedisView.open(connNoDb, manager, 'console');
    await v2.handleMessage({ type: 'ready' });
    await v2.handleMessage({ type: 'ready' });
    expect(sent.some(([n, a]) => n === 'SELECT' && a.join() === '0')).toBe(true);
    expect(session.db).toBe(0);
  });

  it('status 视图：config.db=null 且只推 INFO（ServerStatus 可达）', async () => {
    const { view } = makeView(async (n) => (n === 'INFO' ? 'redis_version:7' : n === 'SLOWLOG' ? [] : 'OK'), undefined, 'serverStatus');
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    const cfg = posts(view).find((m) => m.type === 'config');
    expect(cfg.db).toBeNull();
    expect(cfg.panel).toBe('serverStatus');
    expect(posts(view).some((m) => m.type === 'info')).toBe(true);
    expect(posts(view).some((m) => m.type === 'keys')).toBe(false);
  });

  it('console 单栏面板不加载键树（S5 拆分）', async () => {
    const { view } = makeView(async (n) => (n === 'SCAN' ? ['0', []] : n === 'INFO' ? '' : n === 'SLOWLOG' ? [] : 'OK'), undefined, 'console');
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(posts(view).some((m) => m.type === 'keys')).toBe(false);
    expect(posts(view).some((m) => m.type === 'info')).toBe(false);
  });

  it('console 带 db 打开：归一到该 db 且 config.db 反映它', async () => {
    const sent: [string, string[]][] = [];
    const session: any = {
      kind: 'redis', db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {},
      client: {
        sendCommand: async (n: string, a: string[] = []) => { sent.push([n, a]); return 'OK'; },
        runExclusive: <T>(fn: () => Promise<T>): Promise<T> => fn(),
        info: async () => '',
      },
    };
    const manager: any = { retain: vi.fn(), release: vi.fn(), connect: async () => session };
    const dbConn: any = { id: 'c9', name: 'r', dbType: 'REDIS', host: 'h', port: 6379 };
    const view: any = RedisView.open(dbConn, manager, 'console', 2);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(sent.some(([n, a]) => n === 'SELECT' && a.join() === '2')).toBe(true);
    const cfg = posts(view).find((m) => m.type === 'config');
    expect(cfg.db).toBe(2);
    expect(cfg.panel).toBe('console');
  });

  it('createKey 已存在：拒绝且不覆盖', async () => {
    const { view, sent } = makeView(async (n) => (n === 'EXISTS' ? 1 : 'OK'), 0);
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    sent.length = 0;
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'createKey', key: 'user:1', value: { kind: 'string', text: 'x' }, ttlSeconds: null });
    expect(sent.some(([n]) => n === 'SET')).toBe(false);
    const ka = posts(view).find((m) => m.type === 'keyAction');
    expect(ka.ok).toBe(false);
  });

  it('renameKey 目标已存在：拒绝', async () => {
    const { view, sent } = makeView(async (n) => (n === 'EXISTS' ? 1 : 'OK'), 0);
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    sent.length = 0;
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'renameKey', key: 'a', newKey: 'b' });
    expect(sent.some(([n]) => n === 'RENAME')).toBe(false);
    expect(posts(view).find((m) => m.type === 'keyAction').ok).toBe(false);
  });
});

describe('RedisView S4 cluster 键扫描', () => {
  it('逐 master SCAN 合并；cluster 不发 SELECT', async () => {
    const calls: { cmd: string; args: (string | number)[] }[] = [];
    const node = (keys: string[]) => ({
      call: async (cmd: string, ...args: (string | number)[]) => { calls.push({ cmd, args }); return cmd === 'SCAN' ? ['0', keys] : 'OK'; },
    });
    const client: any = {
      isCluster: true, mode: 'cluster', db: 0,
      nodes: () => [node(['a:1']), node(['b:1'])],
      sendCommand: async () => 'OK', runExclusive: (fn: any) => fn(), info: async () => '', ping: async () => 'PONG', isAlive: () => true,
    };
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({ kind: 'redis', client, db: 0, mode: 'cluster', readOnly: false, isAlive: () => true, close: () => {} }),
    };
    const view: any = RedisView.open(conn, manager, 'keyBrowser', 0);
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    const keys = (view.post as any).mock.calls.map((c: any[]) => c[0]).find((m: any) => m.type === 'keys');
    expect(keys).toBeTruthy();
    expect(keys.folders.folders.map((f: any) => f.name).sort()).toEqual(['a', 'b']);
    expect(keys.folders.folders.flatMap((f: any) => f.keys).sort()).toEqual(['a:1', 'b:1']);
    expect(keys.done).toBe(true);
    // Cluster 无 SELECT，也应发给两个 master 各一次 SCAN。
    expect(calls.filter((c) => c.cmd === 'SCAN').length).toBe(2);
    expect(calls.some((c) => c.cmd === 'SELECT')).toBe(false);
  });
});

describe('RedisView S4 Stream 处理器', () => {
  const replies: Record<string, unknown> = {
    SCAN: ['0', []], INFO: '', SLOWLOG: [],
    TYPE: 'stream', TTL: -1, MEMORY: 128,
    XRANGE: [['1-0', ['f', 'v']]], XREVRANGE: [['5-0', ['f', 'v']]], XLEN: 1,
    XINFO: [['name', 'g', 'consumers', '1', 'pending', '0', 'last-delivered-id', '1-0']],
    XADD: '6-0', XDEL: 1, XTRIM: 1, XGROUP: 1,
  };
  const handler: Send = async (name) => (name in replies ? replies[name] : 'OK');

  async function mount(view: any): Promise<void> {
    (view.post as any).mockClear();
    h.audits.length = 0;
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
  }

  it('selectKey 派发 stream 值（entries/len/groups）', async () => {
    const { view } = makeView(handler, 0);
    await mount(view);
    await view.handleMessage({ type: 'selectKey', key: 's' });
    const v = posts(view).find((m) => m.type === 'value');
    expect(v.keyType).toBe('stream');
    expect(v.data.kind).toBe('stream');
    expect(v.data.entries).toEqual([{ id: '1-0', fields: [['f', 'v']] }]);
    expect(v.data.groups.length).toBe(1);
  });

  it('streamAdd：非法 ID 拒绝且不发包', async () => {
    const { view, sent } = makeView(handler, 0);
    await mount(view);
    sent.length = 0;
    await view.handleMessage({ type: 'streamAdd', key: 's', id: 'abc', fields: [['f', 'v']] });
    expect(sent.some(([n]) => n === 'XADD')).toBe(false);
    const ka = posts(view).find((m) => m.type === 'keyAction');
    expect(ka.ok).toBe(false);
  });

  it('streamAdd：ID 不大于末条拒绝', async () => {
    const { view, sent } = makeView(handler, 0);
    await mount(view);
    sent.length = 0;
    await view.handleMessage({ type: 'streamAdd', key: 's', id: '5-0', fields: [['f', 'v']] });
    expect(sent.some(([n]) => n === 'XADD')).toBe(false);
    expect(posts(view).find((m) => m.type === 'keyAction').ok).toBe(false);
  });

  it('streamAdd：* 正常执行并审计', async () => {
    const { view, sent } = makeView(handler, 0);
    await mount(view);
    sent.length = 0;
    await view.handleMessage({ type: 'streamAdd', key: 's', id: '*', fields: [['f', 'v']] });
    expect(sent.some(([n]) => n === 'XADD')).toBe(true);
    expect(h.audits[0].sql).toBe('XADD s');
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);
  });

  it('批量 XDEL 需确认；确认后执行', async () => {
    const { view, sent } = makeView(handler, 0);
    await mount(view);
    sent.length = 0;
    await view.handleMessage({ type: 'streamDel', key: 's', ids: ['1-0', '2-0'] });
    expect(sent.some(([n]) => n === 'XDEL')).toBe(false);
    expect(posts(view).some((m) => m.type === 'confirmOpRequired')).toBe(true);
    await view.handleMessage({ type: 'streamDel', key: 's', ids: ['1-0', '2-0'], confirmed: true });
    expect(sent.some(([n]) => n === 'XDEL')).toBe(true);
  });

  it('XTRIM / XGROUP DESTROY 需确认', async () => {
    const { view, sent } = makeView(handler, 0);
    await mount(view);
    sent.length = 0;
    await view.handleMessage({ type: 'streamTrim', key: 's', maxlen: 100 });
    await view.handleMessage({ type: 'streamGroupDestroy', key: 's', group: 'g' });
    expect(sent.some(([n]) => n === 'XTRIM' || n === 'XGROUP')).toBe(false);
    expect(posts(view).filter((m) => m.type === 'confirmOpRequired').length).toBe(2);
  });

  it('单条 XDEL 走普通管线（无确认）', async () => {
    const { view, sent } = makeView(handler, 0);
    await mount(view);
    sent.length = 0;
    await view.handleMessage({ type: 'streamDel', key: 's', ids: ['1-0'] });
    expect(sent.some(([n]) => n === 'XDEL')).toBe(true);
    expect(posts(view).some((m) => m.type === 'confirmOpRequired')).toBe(false);
  });

  it('只读拦截错误在 viewer 可见（keyAction.error）', async () => {
    const { view } = makeView(async (n) => {
      if (n === 'XADD') throw new Error('command blocked in read-only mode: XADD');
      return n in replies ? replies[n] : 'OK';
    }, 0);
    await mount(view);
    await view.handleMessage({ type: 'streamAdd', key: 's', id: '*', fields: [['f', 'v']] });
    const ka = posts(view).find((m) => m.type === 'keyAction');
    expect(ka.ok).toBe(false);
    expect(ka.error).toMatch(/read-only/);
  });

  it('streamRange 用排他起点续页', async () => {
    const { view } = makeView(handler, 0);
    await mount(view);
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'streamRange', key: 's', start: '1-0' });
    const r = posts(view).find((m) => m.type === 'streamRangeResult');
    expect(r).toBeTruthy();
    // 排他起点由 host 拼成 `(1-0`；handler 里 XRANGE 回复固定，done 由页大小决定。
    expect(r.done).toBe(true);
  });
});

describe('RedisView S4 大集合分页兜底（HSCAN/SSCAN）', () => {
  async function selectAndCapture(handler: Send): Promise<{ posts: any[]; calls: string[] }> {
    const calls: string[] = [];
    const wrapped: Send = async (n, a) => { calls.push(n); return handler(n, a); };
    const { view } = makeView(wrapped, 0);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    (view.post as any).mockClear();
    calls.length = 0;
    await view.handleMessage({ type: 'selectKey', key: 'big' });
    return { posts: posts(view), calls };
  }

  it('hash：用 HSCAN 分页，不用 HGETALL', async () => {
    const h: Send = async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null; // 不可用也不影响（不再全量拉）
      if (n === 'HSCAN') return ['0', ['f', 'v']];
      if (n === 'HLEN') return 1;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { posts: ps, calls } = await selectAndCapture(h);
    const v = ps.find((m) => m.type === 'value');
    expect(v.data).toEqual({ kind: 'hash', entries: [['f', 'v']], len: 1 });
    expect(calls).toContain('HSCAN');
    expect(calls).not.toContain('HGETALL');
  });

  it('set：用 SSCAN 分页，不用 SMEMBERS', async () => {
    const h: Send = async (n) => {
      if (n === 'TYPE') return 'set';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'SSCAN') return ['0', ['m1', 'm2']];
      if (n === 'SCARD') return 2;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { posts: ps, calls } = await selectAndCapture(h);
    const v = ps.find((m) => m.type === 'value');
    expect(v.data).toEqual({ kind: 'set', members: ['m1', 'm2'], card: 2 });
    expect(calls).toContain('SSCAN');
    expect(calls).not.toContain('SMEMBERS');
  });
});

describe('RedisView S4 命令日志订阅', () => {
  it('订阅 client 命令日志并逐条下发 commandLog', async () => {
    let listener: ((e: any) => void) | null = null;
    const client: any = {
      isCluster: false, mode: 'standalone', db: 0,
      sendCommand: async () => 'OK', info: async () => '',
      addLogListener: (l: (e: any) => void) => { listener = l; return () => { listener = null; }; },
    };
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({ kind: 'redis', client, db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }),
    };
    const view: any = RedisView.open(conn, manager, 'commandLog');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(listener).toBeTruthy();

    (view.post as any).mockClear();
    listener!({ command: 'SET', args: ['k', 'v'], durationMs: 3, ok: true, error: undefined });
    const m = (view.post as any).mock.calls.map((c: any[]) => c[0]).find((x: any) => x.type === 'commandLog');
    expect(m.entry).toEqual({ command: 'SET', args: ['k', 'v'], durationMs: 3, ok: true, error: null });
  });
});

describe('RedisView S4 连接事件日志', () => {
  it('订阅 client 事件 → 下发 connectionEvent；reconnecting/end 写审计', async () => {
    const handlers = new Map<string, (...a: any[]) => void>();
    const client: any = {
      isCluster: false, mode: 'standalone', db: 0,
      sendCommand: async () => 'OK', info: async () => '',
      on: (ev: string, l: (...a: any[]) => void) => { handlers.set(ev, l); },
      addLogListener: () => () => {},
    };
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({ kind: 'redis', client, db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }),
    };
    const view: any = RedisView.open(conn, manager, 'commandLog');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(handlers.has('reconnecting')).toBe(true);

    (view.post as any).mockClear();
    h.audits.length = 0;
    handlers.get('reconnecting')!(new Error('switch'));
    const m = (view.post as any).mock.calls.map((c: any[]) => c[0]).find((x: any) => x.type === 'connectionEvent');
    expect(m.event).toBe('reconnecting');
    expect(m.detail).toContain('switch');
    expect(h.audits.some((a) => a.sql === 'connection:reconnecting')).toBe(true);

    (view.post as any).mockClear();
    handlers.get('ready')!();
    expect((view.post as any).mock.calls.some((c: any[]) => c[0].type === 'connectionEvent' && c[0].event === 'ready')).toBe(true);
  });

  it('同连接多面板仅一个实例写 connection:* 审计（去重）', async () => {
    const listeners: Record<string, ((...a: any[]) => void)[]> = {};
    const client: any = {
      isCluster: false, mode: 'standalone', db: 0,
      sendCommand: async () => 'OK', runExclusive: (fn: any) => fn(), info: async () => '',
      on: (ev: string, l: (...a: any[]) => void) => { (listeners[ev] ??= []).push(l); },
      addLogListener: () => () => {},
    };
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({ kind: 'redis', client, db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }),
    };
    const a: any = RedisView.open(conn, manager, 'console');
    const b: any = RedisView.open(conn, manager, 'commandLog');
    for (const v of [a, b]) { await v.handleMessage({ type: 'ready' }); await v.handleMessage({ type: 'ready' }); }
    expect(listeners['reconnecting']?.length).toBe(2);

    h.audits.length = 0;
    for (const l of listeners['reconnecting']) l(new Error('switch'));
    expect(h.audits.filter((x) => x.sql === 'connection:reconnecting')).toHaveLength(1);
  });
});
