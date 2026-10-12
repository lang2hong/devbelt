import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiSessionStore } from '../../src/ai/aiSessionStore';

function makeStore(): { store: AiSessionStore; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const memento = {
    get<T>(key: string, fallback?: T): T | undefined {
      return (data.has(key) ? data.get(key) : fallback) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  };
  return { store: new AiSessionStore(memento as any), data };
}

describe('AiSessionStore（会话历史，本地 Memento）', () => {
  it('create/save/list：按 updatedAt 倒序', async () => {
    const { store } = makeStore();
    const a = store.create();
    a.title = 'A';
    a.updatedAt = 1000;
    store.save(a);
    const b = store.create();
    b.title = 'B';
    b.updatedAt = 2000;
    store.save(b);

    expect(store.list().map((s) => s.title)).toEqual(['B', 'A']);
    expect(store.get(a.id)?.title).toBe('A');
  });

  it('titleFromFirstMessage：空白折叠与 30 字符截断', () => {
    expect(AiSessionStore.titleFromFirstMessage('  帮我   查一下\n订单 ')).toBe('帮我 查一下 订单');
    const long = AiSessionStore.titleFromFirstMessage('x'.repeat(100));
    expect(long).toHaveLength(30);
    expect(long.endsWith('…')).toBe(true);
  });

  it('会话数上限 20：淘汰最旧', async () => {
    const { store } = makeStore();
    for (let i = 0; i < 25; i += 1) {
      const s = store.create();
      s.title = `s${i}`;
      s.updatedAt = i;
      store.save(s);
    }
    const list = store.list();
    expect(list).toHaveLength(20);
    expect(list.map((s) => s.title)).not.toContain('s0');
    expect(list.map((s) => s.title)).toContain('s24');
  });

  it('单会话消息上限 200：保留最新', async () => {
    const { store } = makeStore();
    const s = store.create();
    for (let i = 0; i < 250; i += 1) s.messages.push({ role: 'user', content: `m${i}` });
    store.save(s);
    const loaded = store.get(s.id)!;
    expect(loaded.messages).toHaveLength(200);
    expect(loaded.messages[0].content).toBe('m50');
    expect(loaded.messages[199].content).toBe('m249');
  });

  it('rename / delete', () => {
    const { store } = makeStore();
    const s = store.create();
    store.rename(s.id, '  新标题  ');
    expect(store.get(s.id)?.title).toBe('新标题');
    store.delete(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });

  it('损坏条目（缺 id/messages）被忽略，不抛错', () => {
    const { store, data } = makeStore();
    data.set('devbelt.ai.chatSessions', [
      { title: 'bad' },
      { id: 'ok', title: 'ok', messages: [{ role: 'user', content: 'hi' }], updatedAt: 1 },
    ]);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('ok');
  });
});