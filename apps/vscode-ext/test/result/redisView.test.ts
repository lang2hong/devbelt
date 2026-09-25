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

function makeView(handler?: Send) {
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
  RedisView.open(conn, manager, 'console');
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
