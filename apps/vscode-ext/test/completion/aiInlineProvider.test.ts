import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key in h.config ? h.config[key] : fallback),
    }),
  },
  Range: class {
    constructor(public start: unknown, public end: unknown) {}
  },
  InlineCompletionItem: class {
    constructor(public insertText: string, public range: unknown) {}
  },
  InlineCompletionTriggerKind: { Invoke: 1, Automatic: 0 },
  Uri: {},
}));

import { AiInlineProvider } from '../../src/completion/aiInlineProvider';
import type { AiService } from '../../src/ai/aiService';

/** 最小 TextDocument 假实现（行/列 ↔ offset 转换，零宽补全范围路径）。 */
class FakeDoc {
  uri = { scheme: 'file', toString: () => 'file:///q.sql' };
  constructor(public text: string) {}
  getText(range?: { start: any; end: any }): string {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  offsetAt(pos: { line: number; character: number }): number {
    const lines = this.text.split('\n');
    let offset = 0;
    for (let i = 0; i < pos.line; i += 1) offset += lines[i].length + 1;
    return offset + pos.character;
  }
  positionAt(offset: number): { line: number; character: number } {
    const before = this.text.slice(0, offset);
    const lines = before.split('\n');
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
  }
  getWordRangeAtPosition(): undefined {
    return undefined; // 走零宽插入范围
  }
}

function makeToken(): { token: any; cancel: () => void } {
  let cancelled = false;
  const callbacks: Array<() => void> = [];
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(cb: () => void) {
        callbacks.push(cb);
        return { dispose: () => {} };
      },
    },
    cancel: () => {
      cancelled = true;
      for (const cb of callbacks) cb();
    },
  };
}

function makeProvider(chat: any): AiInlineProvider {
  return new AiInlineProvider({
    service: { chat } as unknown as AiService,
    manager: { peekSql: () => undefined } as never,
    connCtx: { getForDoc: () => undefined } as never,
  });
}

const DOC_TEXT = 'SELECT * FROM orders WHERE ';
const context = (triggerKind: number) => ({ triggerKind }) as never;

describe('AiInlineProvider（Invoke-only / debounce / abort）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.config = { 'ai.enableInlineCompletion': true };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Automatic 触发（普通打字）不发请求', async () => {
    const chat = vi.fn();
    const result = await makeProvider(chat).provideInlineCompletionItems(
      new FakeDoc(DOC_TEXT) as never,
      new FakeDoc(DOC_TEXT).positionAt(DOC_TEXT.length) as never,
      context(0),
      makeToken().token,
    );
    expect(result).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it('开关关闭时不发请求', async () => {
    h.config = { 'ai.enableInlineCompletion': false };
    const chat = vi.fn();
    const doc = new FakeDoc(DOC_TEXT);
    const result = await makeProvider(chat).provideInlineCompletionItems(
      doc as never,
      doc.positionAt(DOC_TEXT.length) as never,
      context(1),
      makeToken().token,
    );
    expect(result).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it('Invoke：300ms debounce 后请求，返回单条补全（trim 后文本）', async () => {
    const chat = vi.fn(async (..._args: unknown[]) => ({ content: ' status = 1', model: 'm' }));
    const doc = new FakeDoc(DOC_TEXT);
    const promise = makeProvider(chat).provideInlineCompletionItems(
      doc as never,
      doc.positionAt(DOC_TEXT.length) as never,
      context(1),
      makeToken().token,
    );

    // debounce 期内未请求
    await vi.advanceTimersByTimeAsync(200);
    expect(chat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    const result = await promise;
    expect(chat).toHaveBeenCalledTimes(1);
    const request = chat.mock.calls[0][0] as unknown as { messages: Array<{ content: string }>; temperature: number; maxTokens: number };
    expect(request.messages[1].content).toContain('SQL before cursor:\nSELECT * FROM orders WHERE');
    expect(request.temperature).toBe(0);
    expect(result).toHaveLength(1);
    expect(result![0].insertText).toBe('status = 1');
  });

  it('debounce 期内取消（继续打字）→ 不请求', async () => {
    const chat = vi.fn();
    const doc = new FakeDoc(DOC_TEXT);
    const t = makeToken();
    const promise = makeProvider(chat).provideInlineCompletionItems(
      doc as never,
      doc.positionAt(DOC_TEXT.length) as never,
      context(1),
      t.token,
    );
    await vi.advanceTimersByTimeAsync(100);
    t.cancel();
    await vi.advanceTimersByTimeAsync(400);
    await expect(promise).resolves.toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it('5s 超时：abort 在途请求并静默返回', async () => {
    let aborted = false;
    const chat = vi.fn(
      (_req: unknown, _meta: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { code: 'AI_ABORTED' }));
          });
        }),
    );
    const doc = new FakeDoc(DOC_TEXT);
    const promise = makeProvider(chat).provideInlineCompletionItems(
      doc as never,
      doc.positionAt(DOC_TEXT.length) as never,
      context(1),
      makeToken().token,
    );
    await vi.advanceTimersByTimeAsync(400); // debounce 完成，进入请求
    await vi.advanceTimersByTimeAsync(5100); // 超时
    await expect(promise).resolves.toBeUndefined();
    expect(aborted).toBe(true);
  });

  it('口令字面量：直接不发请求', async () => {
    const chat = vi.fn();
    const text = "CREATE USER u IDENTIFIED BY 'pw' AND ";
    const doc = new FakeDoc(text);
    const result = await makeProvider(chat).provideInlineCompletionItems(
      doc as never,
      doc.positionAt(text.length) as never,
      context(1),
      makeToken().token,
    );
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(chat).not.toHaveBeenCalled();
  });

  it('哨兵 <none> / 围栏包裹 / 空输出 → 不下发建议', async () => {
    for (const content of ['<none>', '```sql\nWHERE 1\n```', '   ']) {
      const chat = vi.fn(async () => ({ content, model: 'm' }));
      const doc = new FakeDoc(DOC_TEXT);
      const promise = makeProvider(chat).provideInlineCompletionItems(
        doc as never,
        doc.positionAt(DOC_TEXT.length) as never,
        context(1),
        makeToken().token,
      );
      await vi.advanceTimersByTimeAsync(400);
      await expect(promise).resolves.toBeUndefined();
    }
  });
});