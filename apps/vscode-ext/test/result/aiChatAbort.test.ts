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

/** A stream that yields one chunk and then hangs until aborted, like a slow model. */
interface AbortableStream extends AsyncIterable<any> { abort(): void }

function hangingStream(): { stream: AbortableStream; aborted: () => boolean } {
  let aborted = false;
  let release!: (err: Error) => void;
  const stream = {
    abort(): void {
      aborted = true;
      release(Object.assign(new Error('aborted'), { code: 'AI_ABORTED' }));
    },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: (): Promise<IteratorResult<any>> => {
          if (!sent) {
            sent = true;
            return Promise.resolve({ done: false, value: { delta: 'partial answer' } });
          }
          return new Promise((_, reject) => { release = reject; });
        },
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
  return { stream, aborted: () => aborted };
}

function deps(streamFactory: () => any) {
  const session = { id: 's1', title: 't', messages: [] as any[], createdAt: 0, updatedAt: 0 };
  const sessions = {
    get: (id: string) => (id === 's1' ? session : undefined),
    create: () => session,
    save: vi.fn(),
    list: () => [session],
    delete: vi.fn(),
    rename: vi.fn(),
  };
  return {
    session,
    service: {
      streamChat: streamFactory,
      describeProvider: async () => ({ mode: 'server-proxy', model: '', baseUrl: '', available: true }),
      fetchUsage: async () => null,
    },
    sessions,
    contextStore: { getLastScope: () => undefined, get: () => undefined, set: vi.fn() } as any,
    keyStore: { getApiKey: async () => undefined, hasApiKey: async () => false } as any,
    manager: { peek: () => undefined, openIsolatedSql: vi.fn() } as any,
    connectionStore: { get: () => undefined, list: () => [] } as any,
    memento: { get: () => undefined, update: async () => undefined } as any,
    auth: { isLoggedIn: () => true },
    executor: {} as any,
    modelAccessStore: { current: () => ({}), getPrefs: () => ({ selection: true, custom: true, key: true }), setPrefs: async () => undefined, saveLocal: async () => undefined } as any,
    providerCatalog: { get: async () => [] } as any,
    ledgerPath: '/tmp/opencode/ledger.jsonl',
  };
}

function messages(): any[] {
  return h.post.mock.calls.map((c) => c[0]).filter((m) => m && typeof m === 'object');
}

function finishes(): any[] {
  return messages().filter((m) => m.type === 'finish');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('AI Chat 停止', () => {
  beforeEach(() => {
    h.post.mockClear();
    AiChatView.closeAll();
  });

  it('停止后仍以 finish(aborted) 收尾，界面不会卡在「思考中」', async () => {
    const { stream } = hangingStream();
    const view: any = AiChatView.open(deps(() => stream) as any);
    const run = view.runRequest(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'hi' }],
      { feature: 'chat' },
    );

    await flush();
    expect(finishes()).toHaveLength(0);
    await view.handleMessage({ type: 'abort' });
    await run;
    await flush();

    const finish = finishes()[0];
    expect(finish).toMatchObject({ type: 'finish', sessionId: 's1', aborted: true, content: 'partial answer' });
    expect(view.activeStream).toBeUndefined();
  });

  it('停止之后可以发起下一次请求（生成状态可恢复）', async () => {
    const first = hangingStream();
    let calls = 0;
    const view: any = AiChatView.open(deps(() => (calls++ === 0 ? first.stream : completedStream('second answer'))) as any);

    void view.runRequest(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'hi' }],
      { feature: 'chat' },
    );
    await flush();
    await view.handleMessage({ type: 'abort' });
    await flush();

    await view.runRequest(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'again' }],
      { feature: 'chat' },
    );
    const all = finishes();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ aborted: true });
    expect(all[1]).toMatchObject({ content: 'second answer' });
    expect(all[1].aborted).toBeUndefined();
  });

  it('Agent 模式停止同样收尾，且不把中止当成错误', async () => {
    const { stream } = hangingStream();
    const viewed = deps(() => stream);
    // Agent 需要连接与会话：给出最小可用的独立会话。
    const query = { query: vi.fn(async () => ({ rows: [] })), wrap: (s: string) => `\`${s}\`` };
    viewed.connectionStore.get = (id: string) => (id === 'c1'
      ? { id: 'c1', name: 'local', host: 'localhost', dbType: 'MYSQL', database: 'app' }
      : undefined);
    viewed.manager.openIsolatedSql = vi.fn(async () => ({ session: { query, metadata: {}, kind: 'sql' }, close: vi.fn() }));
    const view: any = AiChatView.open(viewed as any);

    void view.runAgent(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'count orders' }],
      { id: 'c1', name: 'local', host: 'localhost', dbType: 'MYSQL', database: 'app' },
    );
    await flush();
    expect(finishes()).toHaveLength(0);
    await view.handleMessage({ type: 'abort' });
    await flush();

    const finish = finishes()[0];
    expect(finish).toMatchObject({ type: 'finish', sessionId: 's1' });
    expect(finish.aborted).toBe(true);
    expect(finish.error).toBeUndefined();
  });

  it('重新生成找不到会话时回一条空 finish，界面不会卡住', async () => {
    const view: any = AiChatView.open(deps(() => completedStream('x')) as any);
    await view.handleMessage({ type: 'regenerate', sessionId: 'gone' });
    expect(finishes()).toEqual([{ type: 'finish', sessionId: 'gone' }]);
  });

  it('取上下文失败时以 finish(error) 收尾', async () => {
    const viewed = deps(() => completedStream('x'));
    viewed.memento.get = () => 'c1';
    viewed.connectionStore.get = () => ({ id: 'c1', name: 'local', host: 'localhost', dbType: 'MYSQL' });
    viewed.manager.peek = () => { throw new Error('connection lost'); };
    const view: any = AiChatView.open(viewed as any);
    await view.handleMessage({ type: 'send', sessionId: 's1', text: 'hi' });
    expect(finishes()).toHaveLength(1);
    expect(finishes()[0].error).toMatchObject({ code: 'AI_CONTEXT_ERROR', message: 'connection lost' });
  });

  it('内联 SQL 执行器抛错时也回终态，结束「执行中」', async () => {
    const viewed = deps(() => completedStream('x'));
    viewed.memento.get = () => 'c1';
    viewed.connectionStore.get = () => ({ id: 'c1', name: 'local', host: 'localhost', dbType: 'MYSQL', database: 'app' });
    viewed.executor = { runHeadless: vi.fn(async () => { throw new Error('socket closed'); }) };
    const view: any = AiChatView.open(viewed as any);
    await view.executeSqlInChat('SELECT 1', { gen: 0, msgIdx: 0, blockIdx: 0 });
    const result = messages().find((m) => m.type === 'toolResult');
    expect(result).toMatchObject({ isError: true, content: 'socket closed', blockRef: { blockIdx: 0 } });
    expect((view as any).runs.size).toBe(0);
  });

  it('新建会话会中止旧会话的在途回复', async () => {
    const { stream, aborted } = hangingStream();
    const view: any = AiChatView.open(deps(() => stream) as any);
    void view.runRequest(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'hi' }],
      { feature: 'chat' },
    );
    await flush();
    await view.handleMessage({ type: 'newChat' });
    await flush();
    expect(aborted()).toBe(true);
    expect(finishes()[0]).toMatchObject({ sessionId: 's1', aborted: true });
  });

  it('删除正在生成的会话会中止回复，避免把它写回去', async () => {
    const { stream, aborted } = hangingStream();
    const viewed = deps(() => stream);
    const view: any = AiChatView.open(viewed as any);
    void view.runRequest(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'hi' }],
      { feature: 'chat' },
    );
    await flush();
    await view.handleMessage({ type: 'deleteChat', sessionId: 's1' });
    await flush();
    expect(aborted()).toBe(true);
    expect(viewed.sessions.delete).toHaveBeenCalledWith('s1');
  });

  it('新请求取代旧请求时仍丢弃旧运行的迟到消息', async () => {
    const first = hangingStream();
    const view: any = AiChatView.open(deps(() => first.stream) as any);
    const old = view.runRequest(
      { id: 's1', title: 't', messages: [], createdAt: 0, updatedAt: 0 },
      [{ role: 'user', content: 'one' }],
      { feature: 'chat' },
    );
    await flush();
    // 新请求内部会 abortStream()（递增 streamSeq），旧运行不得再发 finish。
    view.abortStream();
    first.stream.abort();
    await old;
    await flush();
    expect(finishes()).toHaveLength(0);
  });
});

function completedStream(text: string): AbortableStream {
  return {
    abort(): void { /* noop */ },
    async *[Symbol.asyncIterator]() {
      yield { delta: text };
    },
  };
}