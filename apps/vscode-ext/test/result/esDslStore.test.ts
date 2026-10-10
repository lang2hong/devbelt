import { describe, expect, it } from 'vitest';
import { EsDslStore } from '../../src/result/esDslStore';

function makeMemento(initial: unknown = undefined) {
  let data = initial;
  return {
    get: () => data,
    update: (_k: string, v: unknown) => { data = v; return Promise.resolve(); },
    dump: () => data,
  };
}

describe('EsDslStore（P8 S4）', () => {
  it('保存/列出来源隔离（per connId）且按时间倒序', async () => {
    const store = new EsDslStore(makeMemento() as any);
    await store.save('c1', 'q1', 'i1', '{}');
    await store.save('c1', 'q2', 'i2', '{"size":1}');
    await store.save('c2', 'other', 'i', '{}');
    expect(store.list('c1').map((q) => q.name).sort()).toEqual(['q1', 'q2']);
    expect(store.list('c2').map((q) => q.name)).toEqual(['other']);
    expect(store.list('c3')).toEqual([]);
  });

  it('同名 upsert：更新 index/body 而不新增', async () => {
    const store = new EsDslStore(makeMemento() as any);
    const first = await store.save('c1', 'q', 'i1', '{"a":1}');
    const again = await store.save('c1', 'q', 'i2', '{"a":2}');
    expect(store.list('c1')).toHaveLength(1);
    expect(again.id).toBe(first.id);
    expect(store.list('c1')[0]).toMatchObject({ index: 'i2', body: '{"a":2}' });
  });

  it('删除按 id；不存在返回 false', async () => {
    const store = new EsDslStore(makeMemento() as any);
    const q = await store.save('c1', 'q', 'i', '{}');
    expect(await store.remove('nope')).toBe(false);
    expect(await store.remove(q.id)).toBe(true);
    expect(store.list('c1')).toEqual([]);
  });

  it('Memento 中脏数据被过滤（不抛错）', () => {
    const store = new EsDslStore(makeMemento([{ id: 'x' }, null, 'bad', { id: 'y', connId: 'c1', name: 'ok', index: '', body: '', at: 0 }]) as any);
    expect(store.list('c1').map((q) => q.id)).toEqual(['y']);
  });
});