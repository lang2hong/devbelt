import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiContextStore, DOMAIN_CONTEXT_PREFIX, DEFAULT_DIRECTIVES_PREFIX } from '../../src/ai/aiContextStore';

function makeMemento(): { memento: any; data: Map<string, unknown> } {
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
  return { memento, data };
}

describe('AiContextStore（连接级域上下文/默认指令）', () => {
  it('读写使用约定的两个 Memento 键；空值删除键', async () => {
    const { memento, data } = makeMemento();
    const store = new AiContextStore(memento);

    await store.setDomainContext('conn-1', 'GMV=已完成订单总额');
    await store.setDefaultDirectives('conn-1', '未说明时排除软删除');
    expect(data.get(`${DOMAIN_CONTEXT_PREFIX}conn-1`)).toBe('GMV=已完成订单总额');
    expect(data.get(`${DEFAULT_DIRECTIVES_PREFIX}conn-1`)).toBe('未说明时排除软删除');
    expect(store.getDomainContext('conn-1')).toBe('GMV=已完成订单总额');
    expect(store.getDefaultDirectives('conn-1')).toBe('未说明时排除软删除');

    await store.setDomainContext('conn-1', '   ');
    expect(data.has(`${DOMAIN_CONTEXT_PREFIX}conn-1`)).toBe(false);
    expect(store.getDomainContext('conn-1')).toBe('');
  });

  it('超长文本截断到 2000 字符（Memento 是整键 JSON，需设界）', async () => {
    const { memento } = makeMemento();
    const store = new AiContextStore(memento);
    await store.setDomainContext('c', 'x'.repeat(5000));
    expect(store.getDomainContext('c')).toHaveLength(2000);
  });

  it('clearForConnection 幂等清理两条键', async () => {
    const { memento, data } = makeMemento();
    const store = new AiContextStore(memento);
    await store.setDomainContext('c', 'a');
    await store.setDefaultDirectives('c', 'b');
    await store.clearForConnection('c');
    expect(data.size).toBe(0);
    await store.clearForConnection('c');
  });

  it('缺失键返回空串（不抛错）', () => {
    const { memento } = makeMemento();
    const store = new AiContextStore(memento);
    expect(store.getDomainContext('none')).toBe('');
    expect(store.getDefaultDirectives('none')).toBe('');
  });
});