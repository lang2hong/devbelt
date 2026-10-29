import { describe, expect, it, vi } from 'vitest';
import {
  FeedbackController,
  LAST_SEEN_REPLY_KEY,
  countUnread,
  type FeedbackThreadEntry,
} from '../../src/feedback/feedbackController';
import { REPLY_KEY_SECRET, type SecretStoreLike } from '../../src/feedback/replyKey';

const REPLY_KEY = 'K'.repeat(43);

function memento(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => { data.set(k, v); },
  };
}

function secrets(initial: Record<string, string> = {}): SecretStoreLike {
  const data = new Map(Object.entries(initial));
  return { get: async (k) => data.get(k), store: async (k, v) => { data.set(k, v); } };
}

function entry(id: string, replyIds: string[]): FeedbackThreadEntry {
  return {
    id,
    category: 'bug',
    content: 'c',
    status: 'triaged',
    createTime: '2026-10-28T00:00:00.000Z',
    replies: replyIds.map((r) => ({ id: r, body: 'b', createTime: '2026-10-28T01:00:00.000Z' })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function make(over: {
  fetchImpl?: typeof fetch;
  token?: string;
  secretData?: Record<string, string>;
  state?: Record<string, unknown>;
  lastSeenState?: Record<string, unknown>;
} = {}) {
  const state = memento(over.state);
  const lastSeen = over.lastSeenState ? memento(over.lastSeenState) : undefined;
  const fetchImpl = over.fetchImpl ?? (vi.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch);
  const controller = new FeedbackController({
    serverUrl: 'https://example.test',
    globalState: state,
    ...(lastSeen ? { lastSeenState: lastSeen } : {}),
    secrets: secrets(over.secretData),
    extensionVersion: '0.4.1',
    os: 'linux/x64',
    getAccessToken: () => over.token,
    fetchImpl,
  });
  return { controller, state, lastSeen, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
}

describe('countUnread', () => {
  it('按数值比较回复 id（非字典序）', () => {
    const items = [entry('1', ['5', '12']), entry('2', [])];
    expect(countUnread(items, 0n)).toBe(2);
    expect(countUnread(items, 5n)).toBe(1);
    expect(countUnread(items, 9n)).toBe(1);
    expect(countUnread(items, 12n)).toBe(0);
  });
});

describe('FeedbackController.refresh', () => {
  it('没有 replyKey 且未登录：不发请求，列表置空', async () => {
    const { controller, fetchImpl } = make();
    await expect(controller.refresh()).resolves.toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(controller.snapshot().items).toEqual([]);
  });

  it('有 replyKey：请求体带 installId 与 replyKey，不带 Authorization', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [entry('1', ['3'])] })) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, secretData: { [REPLY_KEY_SECRET]: REPLY_KEY } });
    await expect(controller.refresh()).resolves.toBe(true);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/db/feedback/thread');
    const body = JSON.parse(String(init.body)) as { installId: string; replyKey: string };
    expect(body.replyKey).toBe(REPLY_KEY);
    expect(body.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(controller.snapshot().items).toHaveLength(1);
  });

  it('已登录：带 Bearer（即使没有 replyKey 也会请求）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, token: 'tok' });
    await controller.refresh();
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.replyKey).toBeUndefined();
  });

  it('并发调用合并为同一次请求', async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { resolve = r; })) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, secretData: { [REPLY_KEY_SECRET]: REPLY_KEY } });
    const a = controller.refresh();
    const b = controller.refresh();
    expect(a).toBe(b);
    // readReplyKey 是异步的：等到 fetch 真正被调用后再放行。
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolve(jsonResponse({ items: [] }));
    await Promise.all([a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 完成后可以再次发起。
    const c = controller.refresh();
    expect(c).not.toBe(a);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    resolve(jsonResponse({ items: [] }));
    await c;
  });

  it('请求失败返回 false 并保留旧数据', async () => {
    const ok = jsonResponse({ items: [entry('1', ['3'])] });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(new Response('x', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline')) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, secretData: { [REPLY_KEY_SECRET]: REPLY_KEY } });

    await expect(controller.refresh()).resolves.toBe(true);
    await expect(controller.refresh()).resolves.toBe(false);
    expect(controller.snapshot().items).toHaveLength(1);
    await expect(controller.refresh()).resolves.toBe(false);
    expect(controller.snapshot().items).toHaveLength(1);
  });

  it('变化时通知监听方，取消订阅后不再通知', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, secretData: { [REPLY_KEY_SECRET]: REPLY_KEY } });
    const listener = vi.fn();
    const off = controller.onDidChange(listener);
    await controller.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    await controller.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('FeedbackController.markAllRead / unread', () => {
  it('沿用旧存储键；标记后未读归零且通知监听方', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [entry('1', ['5', '12'])] })) as unknown as typeof fetch;
    const { controller, state } = make({ fetchImpl, secretData: { [REPLY_KEY_SECRET]: REPLY_KEY } });
    await controller.refresh();
    expect(controller.snapshot().unread).toBe(2);

    const listener = vi.fn();
    controller.onDidChange(listener);
    await controller.markAllRead();
    expect(state.data.get(LAST_SEEN_REPLY_KEY)).toBe('12');
    expect(LAST_SEEN_REPLY_KEY).toBe('devbelt.feedback.lastSeenReplyId');
    expect(controller.snapshot()).toMatchObject({ unread: 0, lastSeen: '12' });
    expect(listener).toHaveBeenCalledTimes(1);

    // 没有新回复时不重复写入、不重复通知。
    await controller.markAllRead();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('升级后：旧的已读水位不会把旧回复重新标成未读', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [entry('1', ['5', '12'])] })) as unknown as typeof fetch;
    const { controller } = make({
      fetchImpl,
      secretData: { [REPLY_KEY_SECRET]: REPLY_KEY },
      state: { [LAST_SEEN_REPLY_KEY]: '12' },
    });
    await controller.refresh();
    expect(controller.snapshot().unread).toBe(0);
  });
});

describe('FeedbackController.submit', () => {
  it('201 → ok，请求体带 replyKey / installId / 版本 / OS，联系方式可省略', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }, 201)) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl });
    await expect(controller.submit({ category: 'bug', content: '  hello  ', contact: '' })).resolves.toBe('ok');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/db/feedback');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ category: 'bug', content: 'hello', appVersion: '0.4.1', os: 'linux/x64' });
    expect(String(body.replyKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.contact).toBeUndefined();
  });

  it('未知分类归为 other；联系方式截断到 200 字符', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }, 201)) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl });
    await controller.submit({ category: 'spam', content: 'x', contact: 'c'.repeat(300) });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { category: string; contact: string };
    expect(body.category).toBe('other');
    expect(body.contact).toHaveLength(200);
  });

  it('已登录时带 Bearer 以关联账号', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }, 201)) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, token: 'tok' });
    await controller.submit({ category: 'bug', content: 'x', contact: '' });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('带图提交：images 原样进入请求体；无图时不发该字段', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1 }, 201)) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl });
    const images = [{ fileName: 'shot.png', dataBase64: 'AAAA' }];
    await expect(controller.submit({ category: 'bug', content: 'x', contact: '', images })).resolves.toBe('ok');
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { images?: unknown }).images).toEqual(images);

    await controller.submit({ category: 'bug', content: 'x', contact: '' });
    const [, init2] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init2.body))).not.toHaveProperty('images');
  });

  it('413 → tooLarge（服务端 body 上限）', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 413 })) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl });
    await expect(controller.submit({ category: 'bug', content: 'x', contact: '' })).resolves.toBe('tooLarge');
  });

  it('429 → rateLimited；其它状态与网络错误 → failed', async () => {
    const mk = (impl: () => Promise<Response>) => make({ fetchImpl: vi.fn(impl) as unknown as typeof fetch }).controller;
    await expect(mk(async () => new Response('', { status: 429 })).submit({ category: 'bug', content: 'x', contact: '' }))
      .resolves.toBe('rateLimited');
    await expect(mk(async () => new Response('', { status: 500 })).submit({ category: 'bug', content: 'x', contact: '' }))
      .resolves.toBe('failed');
    await expect(mk(async () => { throw new Error('offline'); }).submit({ category: 'bug', content: 'x', contact: '' }))
      .resolves.toBe('failed');
  });
});

describe('FeedbackController 账号切换', () => {
  it('onAccountScopeChanged：立即清空旧账号快照、通知监听方，并按当前凭证重拉', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [entry('1', ['3'])] })) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, token: 't1' });
    await controller.refresh();
    expect(controller.snapshot().items).toHaveLength(1);

    let notified = 0;
    controller.onDidChange(() => { notified += 1; });
    controller.onAccountScopeChanged();
    expect(controller.snapshot().items).toEqual([]);
    expect(notified).toBe(1);
    await controller.refresh(); // 并入同一次在途重拉
    expect(controller.snapshot().items).toHaveLength(1);
    expect(notified).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('重拉失败：保持清空，不回显旧账号数据', async () => {
    let ok = true;
    const fetchImpl = vi.fn(async () => (ok
      ? jsonResponse({ items: [entry('1', ['3'])] })
      : jsonResponse({}, 500))) as unknown as typeof fetch;
    const { controller } = make({ fetchImpl, token: 't1' });
    await controller.refresh();
    expect(controller.snapshot().items).toHaveLength(1);

    ok = false;
    controller.onAccountScopeChanged();
    await expect(controller.refresh()).resolves.toBe(false);
    expect(controller.snapshot().items).toEqual([]);
  });

  it('已读水位写 lastSeenState，不落 globalState（installId 仍是设备级）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [entry('1', ['7'])] })) as unknown as typeof fetch;
    const { controller, state, lastSeen } = make({ fetchImpl, token: 't1', lastSeenState: {} });
    await controller.refresh();
    await controller.markAllRead();

    expect(controller.lastSeen()).toBe(7n);
    expect(lastSeen!.data.get(LAST_SEEN_REPLY_KEY)).toBe('7');
    expect(state.data.get(LAST_SEEN_REPLY_KEY)).toBeUndefined();
    // installId 仍走 globalState（设备级匿名身份，不随账号切换）。
    expect([...state.data.keys()].some((k) => /install/i.test(k))).toBe(true);
  });
});
