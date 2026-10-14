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
type PanelOrTab = 'keyBrowser' | 'serverStatus' | 'console' | 'slowlog' | 'monitor';

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

describe('runConsoleLines（AI「在面板运行」注入）', () => {
  it('未就绪：缓存行，第二次 ready 后补发 cliInject（空行过滤/trim）', async () => {
    const { view } = makeView();
    view.runConsoleLines(['  GET k ', '', 'SET a b']);
    expect(posts(view)).toEqual([]);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    const inject = posts(view).find((m: any) => m.type === 'cliInject');
    expect(inject?.lines).toEqual(['GET k', 'SET a b']);
  });

  it('已就绪：立即 post；全空白不发送', async () => {
    const { view } = makeView();
    await mount(view);
    view.runConsoleLines(['PING']);
    expect(posts(view)).toEqual([{ type: 'cliInject', lines: ['PING'] }]);
    (view.post as any).mockClear();
    view.runConsoleLines([' ', '']);
    expect(posts(view)).toEqual([]);
  });
});

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
    // 审计只记命令 + key（首参），不记值：CONFIG 的 subcommand 作为首参，value 被丢弃。
    expect(h.audits[0].sql).toBe('CONFIG SET');
    expect(JSON.stringify(h.audits)).not.toContain('hunter2');
  });

  it('CLI 禁止 SELECT：不发包、返回错误（防错库）', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);

    await view.handleMessage({ type: 'runCommand', id: '1', line: 'SELECT 3' });
    expect(sent.some(([n, a]) => n.toUpperCase() === 'SELECT' && a.join() === '3')).toBe(false);
    const sel = posts(view).find((m) => m.type === 'commandResult');
    expect(sel.ok).toBe(false);
    expect(sel.error).toContain('SELECT');
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
    UNLINK: 1,
    INFO: 'redis_version:7.0.0\r\n# Keyspace\ndb0:keys=3,expires=0,avg_ttl=0\n',
    SLOWLOG: [],
    // 改名防覆盖检查：目标不存在（null/0），否则改名会被拒。
    ZSCORE: null,
    HEXISTS: 0,
  };
  const handler: Send = async (name) => (name in replies ? replies[name] : 'OK');

  async function mountDb(view: any): Promise<void> {
    // 清在 ready 之前：第二次 ready 会主动推 config/keys/info（清在之后会把它们抹掉）。
    (view.post as any).mockClear();
    h.audits.length = 0;
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
  }

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

  it('reloadKeys：树侧写操作后刷新当前值（键树已在 explorer）', async () => {
    const sent: [string, (string | number)[]][] = [];
    const session: any = {
      kind: 'redis', db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {},
      client: {
        sendCommand: async (n: string, a: (string | number)[] = []) => {
          sent.push([n, a]);
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
    expect(sent.some(([n]) => n === 'GET')).toBe(true);
    expect(sent.some(([n]) => n === 'SCAN')).toBe(false);
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

  it('大 key「加载」：绕过门禁强制加载一次', async () => {
    const big: Record<string, unknown> = { ...replies, STRLEN: 2 * 1024 * 1024 };
    const { view } = makeView(async (n) => (n in big ? big[n] : 'OK'), 0);
    await mountDb(view);
    await view.handleMessage({ type: 'selectKey', key: 'user:1' });
    await view.handleMessage({ type: 'load', key: 'user:1' });
    const vals = posts(view).filter((m) => m.type === 'value');
    const last = vals[vals.length - 1];
    expect(last.tooLarge).toBe(false);
    expect(last.data).toBeTruthy();
  });

  it('CLI 拒绝改变/阻塞连接状态的命令（RESET 等）', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);
    sent.length = 0;
    await view.handleMessage({ type: 'runCommand', id: '9', line: 'RESET' });
    expect(sent.some(([n]) => n === 'RESET')).toBe(false);
    const res = posts(view).find((m) => m.type === 'commandResult' && m.id === '9');
    expect(res.ok).toBe(false);
  });

  it('危险命令确认期间切换 db → 拒绝执行（防破坏错库）', async () => {
    const { view, sent, manager } = makeView(handler);
    await mount(view, sent);
    sent.length = 0;
    await view.handleMessage({ type: 'runCommand', id: '7', line: 'FLUSHDB' });
    expect(sent.some(([n]) => n === 'FLUSHDB')).toBe(false);
    // 确认前切库（同面板复用不同 db）→ reconfigure 作废待确认。
    RedisView.open(conn, manager, 'console', 0);
    await view.handleMessage({ type: 'confirmDanger', id: '7', accept: true });
    expect(sent.some(([n]) => n === 'FLUSHDB')).toBe(false);
    const res = posts(view).find((m) => m.type === 'commandResult' && m.id === '7');
    expect(res.ok).toBe(false);
  });

  it('大 key 强制加载超 32MB → 只预览并标 truncated（GETRANGE）', async () => {
    const big: Record<string, unknown> = { ...replies, STRLEN: 40 * 1024 * 1024, GETRANGE: 'preview' };
    const sent: [string, unknown[]][] = [];
    const { view } = makeView(async (n, a) => { sent.push([n, a ?? []]); return n in big ? big[n] : 'OK'; }, 0);
    await mountDb(view);
    await view.handleMessage({ type: 'load', key: 'user:1' });
    const last = posts(view).filter((m) => m.type === 'value').pop();
    expect(last.truncated).toBe(true);
    expect(last.data.kind).toBe('string');
    expect(sent.some(([n]) => n === 'GETRANGE')).toBe(true);
    expect(sent.some(([n]) => n === 'GET')).toBe(false);
  });

  it('listRem 按下标删：下标当前值与旧值不符 → 拒绝（并发保护）', async () => {
    const { view, sent } = makeView(async (n) => (n === 'LINDEX' ? 'changed' : n in replies ? replies[n] : 'OK'), 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'listRem', key: 'k', index: 1, value: 'old' });
    expect(sent.some(([n]) => n === 'LSET')).toBe(false);
    expect(sent.some(([n]) => n === 'LREM')).toBe(false);
  });

  it('listSet 按下标编辑：下标当前值与旧值不符 → 拒绝（并发保护）', async () => {
    const { view, sent } = makeView(async (n) => (n === 'LINDEX' ? 'changed' : n in replies ? replies[n] : 'OK'), 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'listSet', key: 'k', index: 1, value: 'new', original: 'old' });
    expect(sent.some(([n]) => n === 'LSET')).toBe(false);
  });

  it('listSet 按下标编辑：值一致 → 执行 LSET', async () => {
    const { view, sent } = makeView(async (n) => (n === 'LINDEX' ? 'old' : n in replies ? replies[n] : 'OK'), 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'listSet', key: 'k', index: 1, value: 'new', original: 'old' });
    const lset = sent.find(([n]) => n === 'LSET');
    expect(lset).toBeTruthy();
  });

  it('CLI 拒绝 CLIENT REPLY OFF / XREAD ... BLOCK', async () => {
    const { view, sent } = makeView();
    await mount(view, sent);
    sent.length = 0;
    await view.handleMessage({ type: 'runCommand', id: '10', line: 'CLIENT REPLY OFF' });
    await view.handleMessage({ type: 'runCommand', id: '11', line: 'XREAD BLOCK 0 STREAMS s $' });
    expect(sent.some(([n]) => n === 'CLIENT')).toBe(false);
    expect(sent.some(([n]) => n === 'XREAD')).toBe(false);
    const r10 = posts(view).find((m) => m.type === 'commandResult' && m.id === '10');
    const r11 = posts(view).find((m) => m.type === 'commandResult' && m.id === '11');
    expect(r10.ok).toBe(false);
    expect(r11.ok).toBe(false);
  });

  it('大 key 预览只取 1MB（GETRANGE 结束下标 = LARGE_KEY_BYTES-1）', async () => {
    const big: Record<string, unknown> = { ...replies, STRLEN: 40 * 1024 * 1024, GETRANGE: 'preview' };
    const sent: [string, unknown[]][] = [];
    const { view } = makeView(async (n, a) => { sent.push([n, a ?? []]); return n in big ? big[n] : 'OK'; }, 0);
    await mountDb(view);
    await view.handleMessage({ type: 'load', key: 'user:1' });
    const gr = sent.find(([n]) => n === 'GETRANGE');
    expect(String(gr?.[1]?.[2])).toBe(String(1024 * 1024 - 1));
  });

  it('二进制键名（含替换符）写操作一律拒绝', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'saveString', key: 'bad\uFFFDkey', value: 'x' });
    await view.handleMessage({ type: 'renameKey', key: 'bad\uFFFDkey', newKey: 'ok' });
    expect(sent.some(([n]) => n === 'SET')).toBe(false);
    expect(sent.some(([n]) => n === 'RENAME')).toBe(false);
  });

  it('删除类命令返回 0 → keyAction 报失败（不谎报成功）', async () => {
    const { view } = makeView(async (n) => (n === 'HDEL' ? 0 : (n in replies ? replies[n] : 'OK')), 0);
    await mountDb(view);
    await view.handleMessage({ type: 'hashDel', key: 'h', fields: ['f'] });
    const res = posts(view).filter((m) => m.type === 'keyAction').pop();
    expect(res.ok).toBe(false);
  });

  it('非 UTF-8 字段/成员在 value 消息中标记 binaryFields', async () => {
    const { view } = makeView(async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'HLEN') return 1;
      if (n === 'HSCAN') return ['0', ['f\uFFFD', 'v']];
      if (n === 'MEMORY') return 10;
      return n in replies ? replies[n] : 'OK';
    }, 0);
    await mountDb(view);
    await view.handleMessage({ type: 'selectKey', key: 'h' });
    const v = posts(view).filter((m) => m.type === 'value').pop();
    expect(v.keyBinary).toBe(false);
    expect(v.binaryFields).toContain('f\uFFFD');
  });

  it('renameKey 发包并审计', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'renameKey', key: 'user:1', newKey: 'user:9' });
    expect(sent.some(([n]) => n === 'RENAME')).toBe(true);
    expect(h.audits[0].sql).toBe('RENAME user:1');
  });

  it('hashSet 改名：HSET 新 field + HDEL 旧 field（动作串标 HSET+HDEL）', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'hashSet', key: 'h', field: 'new', value: 'v', oldField: 'old' });
    expect(sent.find(([n]) => n === 'HSET')?.[1]).toEqual(['h', 'new', 'v']);
    expect(sent.find(([n]) => n === 'HDEL')?.[1]).toEqual(['h', 'old']);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].sql).toBe('HSET+HDEL h');
  });

  it('hashSet 改名：HDEL 失败仍留痕（partial 审计）', async () => {
    const boom: Send = async (n) => { if (n === 'HDEL') throw new Error('boom'); return n in replies ? replies[n] : 'OK'; };
    const { view } = makeView(boom, 0);
    await mountDb(view);
    h.audits.length = 0;
    await view.handleMessage({ type: 'hashSet', key: 'h', field: 'new', value: 'v', oldField: 'old' });
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok === false)).toBe(true);
    expect(h.audits[0].sql).toContain('HDEL old failed');
  });

  it('hashSet 未改名：仅 HSET（无 HDEL）', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'hashSet', key: 'h', field: 'f', value: 'v', oldField: 'f' });
    expect(sent.some(([n]) => n === 'HSET')).toBe(true);
    expect(sent.some(([n]) => n === 'HDEL')).toBe(false);
  });

  it('zsetAdd 改名：ZADD 新 member + ZREM 旧 member；未改名仅 ZADD', async () => {
    const { view, sent } = makeView(handler, 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'zsetAdd', key: 'z', score: '2', member: 'm2', oldMember: 'm1' });
    expect(sent.find(([n]) => n === 'ZADD')?.[1]).toEqual(['z', '2', 'm2']);
    expect(sent.find(([n]) => n === 'ZREM')?.[1]).toEqual(['z', 'm1']);

    sent.length = 0;
    await view.handleMessage({ type: 'zsetAdd', key: 'z', score: '3', member: 'm2', oldMember: 'm2' });
    expect(sent.some(([n]) => n === 'ZADD')).toBe(true);
    expect(sent.some(([n]) => n === 'ZREM')).toBe(false);
  });

  it('zsetAdd 改名目标已存在 → 拒绝（不静默覆盖）', async () => {
    const { view, sent } = makeView(async (n) => (n === 'ZSCORE' ? '9' : n in replies ? replies[n] : 'OK'), 0);
    await mountDb(view);
    sent.length = 0;
    await view.handleMessage({ type: 'zsetAdd', key: 'z', score: '2', member: 'm2', oldMember: 'm1' });
    expect(sent.some(([n]) => n === 'ZADD')).toBe(false);
  });
});

describe('RedisView 监控面板', () => {
  it('sampleMonitor（standalone）→ 回 monitorSample（INFO 解析）', async () => {
    const { view } = makeView(async () => 'OK', undefined, 'monitor');
    await mount(view);
    await view.handleMessage({ type: 'sampleMonitor' });
    const s = posts(view).find((m) => m.type === 'monitorSample');
    expect(s).toBeTruthy();
    expect(s.metrics.version).toBe('7.0.0');
    expect(s.metrics.keyspace).toEqual([]);
  });

  it('非 monitor 面板的 sampleMonitor 被忽略', async () => {
    const { view } = makeView(async (n) => (n === 'SLOWLOG' ? [] : 'OK'), undefined, 'console');
    await mount(view);
    await view.handleMessage({ type: 'sampleMonitor' });
    expect(posts(view).some((m) => m.type === 'monitorSample')).toBe(false);
  });
});

describe('RedisView S3 回归（提交前评审）', () => {
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
    expect(sent.some(([n, a]) => n === 'select' && a.join() === '2')).toBe(true);
    const cfg = posts(view).find((m) => m.type === 'config');
    expect(cfg.db).toBe(2);
    expect(cfg.panel).toBe('console');
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

describe('RedisView 集合续页（hash/list/set/zset）', () => {
  type Send2 = (name: string, args: string[]) => Promise<unknown>;

  /** 打开键浏览器并加载一个键的首屏，返回 value 消息与驱动句柄。 */
  async function firstPage(handler: Send2, key = 'big'): Promise<{ view: any; first: any }> {
    const { view } = makeView(handler as Send, 0);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'selectKey', key });
    const first = posts(view).find((m) => m.type === 'value');
    return { view, first };
  }

  it('hash：首屏带 SCAN 游标；collectionMore 按游标续页并回 done', async () => {
    const h: Send2 = async (n, a) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return a[1] === '0' ? ['17', ['f1', 'v1']] : ['0', ['f2', 'v2']];
      if (n === 'HLEN') return 2;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { view, first } = await firstPage(h);
    expect(first.data).toEqual({ kind: 'hash', entries: [['f1', 'v1']], len: 2 });
    expect(first.more).toEqual({ cursor: '17', done: false });

    (view.post as any).mockClear();
    await view.handleMessage({ type: 'collectionMore', key: 'big', kind: 'hash', cursor: '17' });
    const more = posts(view).find((m) => m.type === 'collectionMoreResult');
    expect(more.entries).toEqual([['f2', 'v2']]);
    expect(more.more).toEqual({ cursor: '0', done: true });
  });

  it('list：首屏带 offset；续页用 offset 翻页，短页判 done', async () => {
    const h: Send2 = async (n, a) => {
      if (n === 'TYPE') return 'list';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      // 首屏满页（200）→ 可续；续页短页（1）→ done。
      if (n === 'LRANGE') return a[1] === '0' ? Array.from({ length: 200 }, (_, i) => `i${i}`) : ['c'];
      if (n === 'LLEN') return 201;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { view, first } = await firstPage(h);
    expect(first.data.kind).toBe('list');
    expect(first.data.items).toHaveLength(200);
    expect(first.data.len).toBe(201);
    expect(first.more).toEqual({ offset: 200, done: false });

    (view.post as any).mockClear();
    await view.handleMessage({ type: 'collectionMore', key: 'big', kind: 'list', offset: 200 });
    const more = posts(view).find((m) => m.type === 'collectionMoreResult');
    expect(more.items).toEqual(['c']);
    expect(more.more).toEqual({ offset: 201, done: true });
  });

  it('set：SSCAN 游标续页', async () => {
    const h: Send2 = async (n, a) => {
      if (n === 'TYPE') return 'set';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'SSCAN') return a[1] === '0' ? ['9', ['m1']] : ['0', ['m2']];
      if (n === 'SCARD') return 2;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { view, first } = await firstPage(h);
    expect(first.more).toEqual({ cursor: '9', done: false });

    (view.post as any).mockClear();
    await view.handleMessage({ type: 'collectionMore', key: 'big', kind: 'set', cursor: '9' });
    const more = posts(view).find((m) => m.type === 'collectionMoreResult');
    expect(more.members).toEqual(['m2']);
    expect(more.more).toEqual({ cursor: '0', done: true });
  });

  it('zset：ZRANGE offset 续页', async () => {
    const h: Send2 = async (n, a) => {
      if (n === 'TYPE') return 'zset';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      // 首屏满页（200）→ 可续；续页短页（1）→ done。
      if (n === 'ZRANGE') return a[1] === '0'
        ? Array.from({ length: 200 }, (_, i) => [`m${i}`, String(i)])
        : ['m200', '200'];
      if (n === 'ZCARD') return 201;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { view, first } = await firstPage(h);
    expect(first.data.kind).toBe('zset');
    expect(first.data.items).toHaveLength(200);
    expect(first.data.card).toBe(201);
    expect(first.more).toEqual({ offset: 200, done: false });

    (view.post as any).mockClear();
    await view.handleMessage({ type: 'collectionMore', key: 'big', kind: 'zset', offset: 200 });
    const more = posts(view).find((m) => m.type === 'collectionMoreResult');
    expect(more.items).toEqual([['m200', '200']]);
    expect(more.more).toEqual({ offset: 201, done: true });
  });

  it('非法 kind：忽略，不回 collectionMoreResult', async () => {
    const h: Send2 = async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return ['0', ['f', 'v']];
      if (n === 'HLEN') return 1;
      if (n === 'SCAN') return ['0', []];
      if (n === 'INFO') return '';
      if (n === 'SLOWLOG') return [];
      return 'OK';
    };
    const { view } = await firstPage(h);
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'collectionMore', key: 'big', kind: 'stream', cursor: '0' });
    expect(posts(view).some((m) => m.type === 'collectionMoreResult')).toBe(false);
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

  it('dispose 移除 client 事件监听（面板关闭不再 post）', async () => {
    const handlers = new Map<string, (...a: any[]) => void>();
    const removed: string[] = [];
    const client: any = {
      isCluster: false, mode: 'standalone', db: 0,
      sendCommand: async () => 'OK', runExclusive: (fn: any) => fn(), info: async () => '',
      on: (ev: string, l: (...a: any[]) => void) => { handlers.set(ev, l); },
      off: (ev: string, l: (...a: any[]) => void) => { if (handlers.get(ev) === l) handlers.delete(ev); removed.push(ev); },
      addLogListener: () => () => {},
    };
    const manager: any = {
      retain: vi.fn(), release: vi.fn(),
      connect: async () => ({ kind: 'redis', client, db: 0, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }),
    };
    const view: any = RedisView.open(conn, manager, 'commandLog');
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(handlers.size).toBe(6);

    (view.post as any).mockClear();
    view.dispose();
    expect(removed).toHaveLength(6);
    expect(handlers.size).toBe(0);
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

describe('Stage B 二进制集合（3C-1）', () => {
  /** 打开键浏览器并加载一个键的首屏 value（含二进制回复）。 */
  async function openValue(handler: Send, key = 'h'): Promise<{ view: any; sent: [string, RawArg[]][] }> {
    const { view, sent } = makeView(handler, 0);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    (view.post as any).mockClear();
    sent.length = 0;
    await view.handleMessage({ type: 'selectKey', key });
    return { view, sent };
  }

  it('二进制 hash：value 携带 entryBytes（精确 base64）', async () => {
    const field = Buffer.from([0xff, 0x61]);
    const value = Buffer.from([0x00, 0xfe]);
    const { view } = await openValue(async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return ['0', [field, value]];
      if (n === 'HLEN') return 1;
      return 'OK';
    });
    const v = posts(view).filter((m) => m.type === 'value').pop();
    expect(v.data.kind).toBe('hash');
    expect(v.data.entryBytes).toEqual([[field.toString('base64'), value.toString('base64')]]);
  });

  it('二进制 hash 删除：按精确字节 HDEL（Buffer 参数），计数 0 仍报错', async () => {
    const field = Buffer.from([0xff, 0x61]);
    let deleted = 1;
    const { view, sent } = await openValue(async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return ['0', [field, Buffer.from('v')]];
      if (n === 'HLEN') return 1;
      if (n === 'HDEL') return deleted;
      return 'OK';
    });
    sent.length = 0;
    await view.handleMessage({ type: 'hashDel', key: 'h', fields: ['\uFFFD'], fieldsBase64: [field.toString('base64')] });
    const hdel = sent.find(([n]) => n === 'HDEL');
    expect(hdel).toBeTruthy();
    expect(Buffer.isBuffer(hdel![1][1])).toBe(true);
    expect((hdel![1][1] as Buffer).equals(field)).toBe(true);
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);

    // 计数 0（未命中）→ 失败，不谎报成功。
    deleted = 0;
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'hashDel', key: 'h', fields: ['\uFFFD'], fieldsBase64: [field.toString('base64')] });
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok === false)).toBe(true);
  });

  it('二进制 set / zset 成员删除：Buffer 参数精确命中', async () => {
    const member = Buffer.from([0x00, 0xff]);
    const setView = await openValue(async (n) => {
      if (n === 'TYPE') return 'set';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'SSCAN') return ['0', [member]];
      if (n === 'SCARD') return 1;
      if (n === 'SREM') return 1;
      return 'OK';
    }, 's');
    setView.sent.length = 0;
    await setView.view.handleMessage({ type: 'setRem', key: 's', members: ['\uFFFD'], membersBase64: [member.toString('base64')] });
    const srem = setView.sent.find(([n]) => n === 'SREM');
    expect(Buffer.isBuffer(srem![1][1])).toBe(true);
    expect((srem![1][1] as Buffer).equals(member)).toBe(true);

    // 换键/换类型：关闭既有面板实例（RedisView 按 conn:panel 注册，直接 open 会复用旧 handler）。
    RedisView.closeAll();
    const zsetView = await openValue(async (n) => {
      if (n === 'TYPE') return 'zset';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'ZRANGE') return [member, Buffer.from('1')];
      if (n === 'ZCARD') return 1;
      if (n === 'ZREM') return 1;
      return 'OK';
    }, 'z');
    zsetView.sent.length = 0;
    await zsetView.view.handleMessage({ type: 'zsetRem', key: 'z', members: ['\uFFFD'], membersBase64: [member.toString('base64')] });
    const zrem = zsetView.sent.find(([n]) => n === 'ZREM');
    expect(Buffer.isBuffer(zrem![1][1])).toBe(true);
    expect((zrem![1][1] as Buffer).equals(member)).toBe(true);
  });

  it('二进制 list 元素删除：LINDEX 精确比对 + 标记删除；不匹配拒绝', async () => {
    const original = Buffer.from([0xff, 0x00]);
    let current: Buffer | null = original;
    const { view, sent } = await openValue(async (n) => {
      if (n === 'TYPE') return 'list';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'LRANGE') return [original];
      if (n === 'LLEN') return 1;
      if (n === 'LINDEX') return current;
      if (n === 'LREM') return 1;
      return 'OK';
    }, 'l');
    sent.length = 0;
    await view.handleMessage({ type: 'listRem', key: 'l', index: 0, value: '\uFFFD', valueBase64: original.toString('base64') });
    expect(sent.some(([n]) => n === 'LSET')).toBe(true);
    expect(sent.some(([n]) => n === 'LREM')).toBe(true);
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);

    // 并发改动（当前字节不一致）→ 拒绝删除，不执行 LSET/LREM。
    current = Buffer.from([0x01]);
    (view.post as any).mockClear();
    sent.length = 0;
    await view.handleMessage({ type: 'listRem', key: 'l', index: 0, value: '\uFFFD', valueBase64: original.toString('base64') });
    expect(sent.some(([n]) => n === 'LSET')).toBe(false);
    const failed = posts(view).find((m) => m.type === 'keyAction');
    expect(failed.ok).toBe(false);
  });

  it('续页结果携带并行 base64（hash）', async () => {
    const field = Buffer.from([0xfe]);
    const { view } = await openValue(async (n, a) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return a[1] === '0' ? ['5', [Buffer.from('f'), Buffer.from('v')]] : ['0', [field, Buffer.from('v2')]];
      if (n === 'HLEN') return 2;
      return 'OK';
    });
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'collectionMore', key: 'h', kind: 'hash', cursor: '5' });
    const more = posts(view).find((m) => m.type === 'collectionMoreResult');
    expect(more.entries).toEqual([['\uFFFD', 'v2']]);
    expect(more.entryBytes).toEqual([[field.toString('base64'), Buffer.from('v2').toString('base64')]]);
  });

  it('3C-2：二进制 hash 值编辑走 HSET Buffer（field 支持精确字节）', async () => {
    const field = Buffer.from([0xff, 0x61]);
    const value = Buffer.from([0x00, 0xfe]);
    const { view, sent } = await openValue(async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return ['0', [field, Buffer.from('v')]];
      if (n === 'HLEN') return 1;
      return 'OK';
    });
    sent.length = 0;
    await view.handleMessage({
      type: 'hashSet', key: 'h', field: '\uFFFDa', value: 'v',
      fieldBase64: field.toString('base64'), valueBase64: value.toString('base64'),
    });
    const hset = sent.find(([n]) => n === 'HSET');
    expect(hset).toBeTruthy();
    expect(Buffer.isBuffer(hset![1][1])).toBe(true);
    expect((hset![1][1] as Buffer).equals(field)).toBe(true);
    expect((hset![1][2] as Buffer).equals(value)).toBe(true);
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);
  });

  it('3C-2：二进制 field 改名被拒绝（fail-closed，不发 HSET）', async () => {
    const { view, sent } = await openValue(async (n) => {
      if (n === 'TYPE') return 'hash';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'HSCAN') return ['0', [Buffer.from([0xff]), Buffer.from('v')]];
      if (n === 'HLEN') return 1;
      return 'OK';
    });
    sent.length = 0;
    (view.post as any).mockClear();
    await view.handleMessage({
      type: 'hashSet', key: 'h', field: 'new', value: 'v',
      oldField: '\uFFFD', valueBase64: Buffer.from('x').toString('base64'),
    });
    expect(sent.some(([n]) => n === 'HSET')).toBe(false);
    expect(posts(view).find((m) => m.type === 'keyAction').ok).toBe(false);
  });

  it('3C-2：二进制 list 元素编辑走 LINDEX 比对 + LSET Buffer；不匹配拒绝', async () => {
    const original = Buffer.from([0xff, 0x00]);
    let current: Buffer | null = original;
    const { view, sent } = await openValue(async (n) => {
      if (n === 'TYPE') return 'list';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'LRANGE') return [original];
      if (n === 'LLEN') return 1;
      if (n === 'LINDEX') return current;
      return 'OK';
    }, 'l');
    sent.length = 0;
    const next = Buffer.from([0x01, 0x02]);
    await view.handleMessage({
      type: 'listSet', key: 'l', index: 0, value: '\uFFFD', original: '\uFFFD',
      valueBase64: next.toString('base64'), originalBase64: original.toString('base64'),
    });
    const lset = sent.find(([n]) => n === 'LSET');
    expect(lset).toBeTruthy();
    expect(Buffer.isBuffer(lset![1][2])).toBe(true);
    expect((lset![1][2] as Buffer).equals(next)).toBe(true);
    expect(posts(view).some((m) => m.type === 'keyAction' && m.ok)).toBe(true);

    // 并发不匹配 → 拒绝，不发 LSET。
    current = Buffer.from([0x09]);
    sent.length = 0;
    (view.post as any).mockClear();
    await view.handleMessage({
      type: 'listSet', key: 'l', index: 0, value: '\uFFFD', original: '\uFFFD',
      valueBase64: next.toString('base64'), originalBase64: original.toString('base64'),
    });
    expect(sent.some(([n]) => n === 'LSET')).toBe(false);
    expect(posts(view).find((m) => m.type === 'keyAction').ok).toBe(false);
  });

  it('3C-2：二进制 zset member 改 score 走 ZADD Buffer；改名拒绝', async () => {
    const member = Buffer.from([0x00, 0xff]);
    const { view, sent } = await openValue(async (n) => {
      if (n === 'TYPE') return 'zset';
      if (n === 'TTL') return -1;
      if (n === 'MEMORY') return null;
      if (n === 'ZRANGE') return [member, Buffer.from('1')];
      if (n === 'ZCARD') return 1;
      return 'OK';
    }, 'z');
    sent.length = 0;
    await view.handleMessage({ type: 'zsetAdd', key: 'z', score: '2', member: '\uFFFD', memberBase64: member.toString('base64') });
    const zadd = sent.find(([n]) => n === 'ZADD');
    expect(zadd).toBeTruthy();
    expect(Buffer.isBuffer(zadd![1][2])).toBe(true);
    expect((zadd![1][2] as Buffer).equals(member)).toBe(true);

    // 改名（oldMember 与 member 不同）→ 拒绝，不发 ZADD。
    sent.length = 0;
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'zsetAdd', key: 'z', score: '2', member: 'new', oldMember: '\uFFFD', memberBase64: member.toString('base64') });
    expect(sent.some(([n]) => n === 'ZADD')).toBe(false);
    expect(posts(view).find((m) => m.type === 'keyAction').ok).toBe(false);
  });
});
