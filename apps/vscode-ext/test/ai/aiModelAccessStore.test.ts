import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiModelAccessStore, MODEL_ACCESS_RECORD_PREFIX, type StoredModelAccessFields } from '../../src/ai/aiModelAccessStore';
import { setAccountScope } from '../../src/sync/accountScope';

function memento(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get<T>(key: string): T | undefined { return data[key] as T | undefined; },
    update(key: string, value: unknown): Thenable<void> { data[key] = value; return Promise.resolve(); },
    keys(): readonly string[] { return Object.keys(data); },
  };
}

const fields = (model: string): StoredModelAccessFields => ({
  mode: 'openai-compatible', vendorId: 'v', baseUrl: 'https://x/v1', model, customVendors: [], customModels: {},
});

afterEach(() => setAccountScope(undefined));

describe('AiModelAccessStore 按账号隔离', () => {
  it('未登录时不把账号里的记录当成自己的', () => {
    const m = memento({
      [`${MODEL_ACCESS_RECORD_PREFIX}u.u1.rec-1`]: { id: 'rec-1', fields: fields('m'), updateTime: 1 },
    });
    const store = new AiModelAccessStore(m as never);
    setAccountScope(undefined);
    expect(store.listRecords()).toEqual([]);
    expect(store.effective()).toBeUndefined();
  });

  it('先在未登录时访问过，之后登录仍会复制本机记录', async () => {
    const m = memento();
    const store = new AiModelAccessStore(m as never);
    setAccountScope(undefined);
    await store.saveLocal(fields('local-model'));
    expect(store.listRecords()).toHaveLength(1);

    setAccountScope('u1');
    const list = store.listRecords();
    expect(list.map((r) => r.fields.model)).toEqual(['local-model']);
    await Promise.resolve();
    expect(m.data[`${MODEL_ACCESS_RECORD_PREFIX}u.u1.${list[0].id}`]).toBeTruthy();
    expect(m.data[`${MODEL_ACCESS_RECORD_PREFIX}${list[0].id}`]).toBeTruthy();
  });

  it('同一次运行里切到另一个账号也会各自复制一份', async () => {
    const m = memento({ [`${MODEL_ACCESS_RECORD_PREFIX}rec-1`]: { id: 'rec-1', fields: fields('local'), updateTime: 1 } });
    const store = new AiModelAccessStore(m as never);

    setAccountScope('u1');
    expect(store.listRecords().map((r) => r.fields.model)).toEqual(['local']);

    setAccountScope('u2');
    expect(store.listRecords().map((r) => r.fields.model)).toEqual(['local']);
    await Promise.resolve();
    expect(m.data[`${MODEL_ACCESS_RECORD_PREFIX}u.u2.rec-1`]).toBeTruthy();
  });

  it('账号自己的记录优先，且不串到另一个账号', async () => {
    const m = memento({
      [`${MODEL_ACCESS_RECORD_PREFIX}local-rec`]: { id: 'local-rec', fields: fields('local'), updateTime: 1 },
      [`${MODEL_ACCESS_RECORD_PREFIX}u.u1.rec-1`]: { id: 'rec-1', fields: fields('u1'), updateTime: 2 },
    });
    const store = new AiModelAccessStore(m as never);
    setAccountScope('u1');
    expect(store.current().model).toBe('u1');
    setAccountScope('u2');
    expect(store.current().model).toBe('local');
  });
});