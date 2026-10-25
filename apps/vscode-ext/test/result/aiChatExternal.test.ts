import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en', clipboard: { writeText: async () => undefined } },
  commands: { executeCommand: async () => undefined },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    protected readonly panel = { title: '', webview: { postMessage: h.post, asWebviewUri: (u: unknown) => u }, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }) };
    protected initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    protected post(msg: any): void { h.post(msg); }
    reveal(): void { /* noop */ }
    dispose(): void { (this as any).onDispose?.(); }
    protected onDispose(): void { /* noop */ }
  },
}));

import { AiChatView } from '../../src/result/aiChatView';

interface AbortableStream extends AsyncIterable<any> { abort(): void }

function completed(text: string): AbortableStream {
  return {
    abort(): void { /* noop */ },
    async *[Symbol.asyncIterator]() {
      yield { delta: text };
    },
  };
}

function deps() {
  const sessions: any[] = [];
  const store = {
    create: () => {
      const session = { id: `s${sessions.length + 1}`, title: '', messages: [] as any[], createdAt: 0, updatedAt: 0 };
      sessions.push(session);
      return session;
    },
    get: (id: string) => sessions.find((s) => s.id === id),
    save: vi.fn((session: any) => {
      if (!sessions.includes(session)) sessions.push(session);
    }),
    list: () => sessions,
    delete: vi.fn(),
    rename: vi.fn(),
  };
  return {
    sessions,
    store,
    deps: {
      service: {
        streamChat: () => completed('the answer'),
        describeProvider: async () => ({ mode: 'server-proxy', model: '', baseUrl: '', available: true }),
        fetchUsage: async () => null,
      },
      sessions: store,
      contextStore: { getDomainContext: () => undefined, getDefaultDirectives: () => undefined, getLastScope: () => undefined } as any,
      keyStore: { getApiKey: async () => undefined, hasApiKey: async () => false } as any,
      manager: { peek: () => undefined, openIsolatedSql: vi.fn() } as any,
      connectionStore: { get: () => undefined, list: () => [] } as any,
      memento: { get: () => undefined, update: async () => undefined } as any,
      auth: { isLoggedIn: () => true },
      executor: {} as any,
      modelAccessStore: { current: () => ({}), getPrefs: () => ({ selection: true, custom: true, key: true }), setPrefs: async () => undefined, saveLocal: async () => undefined } as any,
      providerCatalog: { get: async () => [] } as any,
      ledgerPath: '/tmp/opencode/ledger.jsonl',
    },
  };
}

function posts(): any[] {
  return h.post.mock.calls.map((c) => c[0]).filter((m) => m && typeof m === 'object');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('外部入口发起的 AI 请求', () => {
  beforeEach(() => {
    h.post.mockClear();
    AiChatView.closeAll();
  });

  it('把用户的提问存进会话，回复后是 [user, assistant]', async () => {
    const { deps: d, sessions } = deps();
    const view: any = AiChatView.open(d as any);
    await view.requestExternal({
      feature: 'optimize',
      title: 'Explain plan',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'why is this query slow?' },
      ],
    });
    const session = sessions[0];
    expect(session.messages.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'why is this query slow?'],
      ['assistant', 'the answer'],
    ]);
    // 面板打开时就能看到提问，而不是只有一条回答。
    const loaded = posts().filter((m) => m.type === 'sessionLoaded').at(-1);
    expect(loaded.session.messages[0]).toMatchObject({ role: 'user', content: 'why is this query slow?' });
  });

  it('没有 user 消息时不写入空条目', async () => {
    const { deps: d, sessions } = deps();
    const view: any = AiChatView.open(d as any);
    await view.requestExternal({
      feature: 'chat',
      title: 'No prompt',
      messages: [{ role: 'system', content: 'only system' }],
    });
    expect(sessions[0].messages.map((m: any) => m.role)).toEqual(['assistant']);
  });

  it('这样生成的会话可以重新生成（host 侧有 user 可重发）', async () => {
    const { deps: d, sessions } = deps();
    const view: any = AiChatView.open(d as any);
    await view.requestExternal({
      feature: 'optimize',
      title: 'Explain plan',
      messages: [{ role: 'user', content: 'why slow?' }],
    });
    h.post.mockClear();
    await view.handleMessage({ type: 'regenerate', sessionId: sessions[0].id });
    await flush();
    // 重新生成本次请求：会话仍以 user 开头，且发出了一次 finish。
    expect(sessions[0].messages[0]).toMatchObject({ role: 'user', content: 'why slow?' });
    expect(posts().some((m) => m.type === 'finish')).toBe(true);
  });
});
describe('AI 对话预填入口', () => {
  beforeEach(() => {
    h.post.mockClear();
    AiChatView.closeAll();
  });

  it('预填只发 prefillInput，不发起请求', async () => {
    const streamChat = vi.fn(() => completed('should not run'));
    const { deps: d } = deps();
    d.service.streamChat = streamChat;
    const view: any = AiChatView.open(d as any);
    await view.handleMessage({ type: 'ready' }); // initSent → 后续可直接下发
    h.post.mockClear();

    view.prefillChat('SELECT * FROM orders');
    const prefill = posts().find((m) => m.type === 'prefillInput');
    expect(prefill?.text).toBe('```sql\nSELECT * FROM orders\n```\n');
    expect(streamChat).not.toHaveBeenCalled();
    expect(posts().some((m) => m.type === 'finish')).toBe(false);
  });

  it('面板尚未 ready 时先暂存，ready 后补发', async () => {
    const { deps: d } = deps();
    const view: any = AiChatView.open(d as any);
    view.prefillChat('SELECT 1');
    expect(posts().some((m) => m.type === 'prefillInput')).toBe(false);

    await view.handleMessage({ type: 'ready' });
    expect(posts().find((m) => m.type === 'prefillInput')?.text).toBe('```sql\nSELECT 1\n```\n');
  });

  it('空白内容不预填', async () => {
    const { deps: d } = deps();
    const view: any = AiChatView.open(d as any);
    await view.handleMessage({ type: 'ready' });
    h.post.mockClear();
    view.prefillChat('   ');
    expect(posts()).toEqual([]);
  });
});
