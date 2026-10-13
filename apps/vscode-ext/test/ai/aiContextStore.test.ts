import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  AiContextStore,
  DOMAIN_CONTEXT_PREFIX,
  DEFAULT_DIRECTIVES_PREFIX,
  LAST_SCOPE_PREFIX,
  SCHEMA_NOTES_PREFIX,
  SELECTED_TABLES_PREFIX,
  findColumnNote,
  findTableNote,
} from '../../src/ai/aiContextStore';

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
    keys(): readonly string[] {
      return [...data.keys()];
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

  it('S7a lastScope：读写命中约定键，脏数据/空值 → undefined，清除后无残留', async () => {
    const { memento, data } = makeMemento();
    const store = new AiContextStore(memento);

    await store.setLastScope('c1', { kind: 'database', value: 'app' });
    expect(data.get(`${LAST_SCOPE_PREFIX}c1`)).toEqual({ kind: 'database', value: 'app' });
    expect(store.getLastScope('c1')).toEqual({ kind: 'database', value: 'app' });

    data.set(`${LAST_SCOPE_PREFIX}c2`, { kind: 'index', value: '' });
    expect(store.getLastScope('c2')).toBeUndefined();

    await store.setLastScope('c1', undefined);
    expect(store.getLastScope('c1')).toBeUndefined();

    await store.setLastScope('c3', { kind: 'redis-db', value: '3' });
    await store.clearForConnection('c3');
    expect(store.getLastScope('c3')).toBeUndefined();
  });

  it('S7d selectedTables：按连接+作用域存读；空选删键；clearForConnection 清所有作用域键', async () => {
    const { memento, data } = makeMemento();
    const store = new AiContextStore(memento);

    await store.setSelectedTables('c1', 'app', ['orders', 'users']);
    expect(data.get(`${SELECTED_TABLES_PREFIX}c1.app`)).toEqual(['orders', 'users']);
    expect(store.getSelectedTables('c1', 'app')).toEqual(['orders', 'users']);
    expect(store.getSelectedTables('c1', 'other_db')).toEqual([]);

    await store.setSelectedTables('c1', 'app', []);
    expect(data.has(`${SELECTED_TABLES_PREFIX}c1.app`)).toBe(false);

    data.set(`${SELECTED_TABLES_PREFIX}c2.db`, ['ok', 5, '']);
    expect(store.getSelectedTables('c2', 'db')).toEqual(['ok']);

    await store.setSelectedTables('c3', 'a', ['t1']);
    await store.setSelectedTables('c3', 'b', ['t2']);
    await store.clearForConnection('c3');
    expect(data.has(`${SELECTED_TABLES_PREFIX}c3.a`)).toBe(false);
    expect(data.has(`${SELECTED_TABLES_PREFIX}c3.b`)).toBe(false);
  });

  it('S7e schemaNotes：保存/读回/大小写兜底/空删/上限拒绝/连接清理', async () => {
    const { memento, data } = makeMemento();
    const store = new AiContextStore(memento);

    const ok = await store.saveTableNote('c1', 'app', 'orders', {
      note: '订单主表',
      columns: [{ name: 'status', note: '0=待支付', sample: '0,1' }],
    });
    expect(ok).toEqual({ ok: true });
    const notes = store.getSchemaNotes('c1', 'app');
    expect(notes.tables['orders']?.note).toBe('订单主表');
    expect(findTableNote(notes, 'ORDERS')?.note).toBe('订单主表');
    expect(findColumnNote(findTableNote(notes, 'orders'), 'STATUS')?.note).toBe('0=待支付');

    // 整表覆盖为空 → 删除条目、清理存储键
    await store.saveTableNote('c1', 'app', 'orders', { note: '', columns: [] });
    expect(store.getSchemaNotes('c1', 'app').tables['orders']).toBeUndefined();
    expect(data.has(`${SCHEMA_NOTES_PREFIX}c1.app`)).toBe(false);

    // 脏数据归一化：非字符串丢弃、超长截断到上限
    data.set(`${SCHEMA_NOTES_PREFIX}c2.db`, { tables: { t: { note: 123, columns: { a: { note: 'x'.repeat(300), sample: 7 } } } } });
    const dirty = store.getSchemaNotes('c2', 'db');
    expect(dirty.tables['t']?.note).toBeUndefined();
    expect(dirty.tables['t']?.columns?.a?.note).toHaveLength(120);
    expect(dirty.tables['t']?.columns?.a?.sample).toBeUndefined();

    // 上限：501 列条目拒绝（不落盘）
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}`, note: 'n' }));
    const rejected = await store.saveTableNote('c3', 'db', 't', { columns: many });
    expect(rejected).toEqual({ ok: false, reason: 'limit' });
    expect(store.getSchemaNotes('c3', 'db').tables['t']).toBeUndefined();

    // clearForConnection 清理注记键
    await store.saveTableNote('c4', 'a', 't', { columns: [{ name: 'c', note: 'n' }] });
    await store.clearForConnection('c4');
    expect(store.getSchemaNotes('c4', 'a').tables).toEqual({});
  });
});