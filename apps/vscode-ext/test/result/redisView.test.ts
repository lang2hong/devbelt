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
    dispose(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/auditLogger', () => ({
  AuditLogger: { tryLog: (entry: any) => { h.audits.push(entry); } },
}));

import { RedisView, formatRedisReply, parseSlowlog, redisAuditLine } from '../../src/result/redisView';

const conn: any = { id: 'c1', name: 'r', dbType: 'REDIS', host: 'h', port: 6379, redisDb: 3, readOnly: false };

type Send = (name: string, args: string[]) => Promise<unknown>;

function makeView(handler?: Send, db?: number, tab: 'status' | 'console' | 'slowlog' = 'console') {
  const sent: [string, string[]][] = [];
  const send: Send = async (name, args) => {
    sent.push([name, args]);
    return handler ? handler(name, args) : 'OK';
  };
  const client = { sendCommand: send, info: async () => 'redis_version:7.0.0\r\n' };
  const manager: any = {
    retain: vi.fn(),
    release: vi.fn(),
    connect: async () => ({ kind: 'redis', client, db: 3, mode: 'standalone', readOnly: false, isAlive: () => true, close: () => {} }),
  };
  RedisView.open(conn, manager, tab, db);
  const view: any = (RedisView as any).current;
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

  it('selectKey 拉取类型化值', async () => {
    const { view } = makeView(handler, 0);
    await mountDb(view);
    await view.handleMessage({ type: 'selectKey', key: 'user:1' });
    const v = posts(view).find((m) => m.type === 'value');
    expect(v.keyType).toBe('string');
    expect(v.data).toEqual({ kind: 'string', text: 'val' });
    expect(v.ttl).toBe(-1);
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
        info: async () => '',
      },
    };
    const manager: any = { retain: vi.fn(), release: vi.fn(), connect: async () => session };
    const connNoDb: any = { id: 'c1', name: 'r', dbType: 'REDIS', host: 'h', port: 6379 };

    RedisView.open(connNoDb, manager, 'console', 2);
    const v1: any = (RedisView as any).current;
    await v1.handleMessage({ type: 'ready' });
    await v1.handleMessage({ type: 'ready' });
    expect(sent.some(([n, a]) => n === 'SELECT' && a.join() === '2')).toBe(true);
    expect(session.db).toBe(2);

    sent.length = 0;
    v1.dispose();
    RedisView.open(connNoDb, manager, 'console');
    const v2: any = (RedisView as any).current;
    await v2.handleMessage({ type: 'ready' });
    await v2.handleMessage({ type: 'ready' });
    expect(sent.some(([n, a]) => n === 'SELECT' && a.join() === '0')).toBe(true);
    expect(session.db).toBe(0);
  });

  it('status 视图：config.db=null 且只推 INFO（ServerStatus 可达）', async () => {
    const { view } = makeView(async (n) => (n === 'INFO' ? 'redis_version:7' : n === 'SLOWLOG' ? [] : 'OK'), undefined, 'status');
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    const cfg = posts(view).find((m) => m.type === 'config');
    expect(cfg.db).toBeNull();
    expect(posts(view).some((m) => m.type === 'info')).toBe(true);
    expect(posts(view).some((m) => m.type === 'keys')).toBe(false);
  });

  it('连接级 console（无 db）仍加载键树（db0）', async () => {
    const { view } = makeView(async (n) => (n === 'SCAN' ? ['0', []] : n === 'INFO' ? '' : n === 'SLOWLOG' ? [] : 'OK'), undefined, 'console');
    (view.post as any).mockClear();
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(posts(view).some((m) => m.type === 'keys')).toBe(true);
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
