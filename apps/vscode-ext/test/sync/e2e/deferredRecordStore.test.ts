import { describe, expect, it } from 'vitest';
import { DeferredRecordStore } from '@devkit/db-host/sync/e2e/deferredRecordStore';

function mem() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

const b64 = (bytes: number) => 'A'.repeat(Math.ceil((bytes * 4) / 3));
const REC_ID = 'A'.repeat(22);

function rec(over: Record<string, unknown> = {}) {
  return {
    recordId: REC_ID,
    version: '1',
    changeSequence: '1',
    deleteTime: null as string | null,
    nonce: b64(12),
    ciphertext: b64(32),
    tag: b64(16),
    ...over,
  };
}

describe('DeferredRecordStore', () => {
  it('put / list / delete / clear 往返', async () => {
    const s = new DeferredRecordStore(mem(), '7', '1');
    await s.put(rec());
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].recordId).toBe(REC_ID);
    await s.delete(REC_ID);
    expect(s.list()).toHaveLength(0);
    await s.put(rec());
    await s.clear();
    expect(s.list()).toHaveLength(0);
  });

  it('同 recordId 覆盖为更新的版本', async () => {
    const s = new DeferredRecordStore(mem(), '7', '1');
    await s.put(rec({ version: '1', changeSequence: '1' }));
    await s.put(rec({ version: '2', changeSequence: '2' }));
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].version).toBe('2');
  });

  it('墓碑不得带密文；非墓碑必须带完整密文', async () => {
    const s = new DeferredRecordStore(mem(), '7', '1');
    await expect(s.put(rec({ deleteTime: '2026-01-01T00:00:00.000Z' }))).rejects.toThrow();
    await expect(s.put(rec({ nonce: undefined }))).rejects.toThrow();
    await expect(s.put(rec({ version: 'x' }))).rejects.toThrow();
  });

  it('超过上限丢最旧 changeSequence', async () => {
    const s = new DeferredRecordStore(mem(), '7', '1');
    for (let i = 0; i <= 1000; i++) {
      await s.put(rec({ recordId: String(i).padStart(22, '0'), version: '1', changeSequence: String(i + 1) }));
    }
    const list = s.list();
    expect(list).toHaveLength(1000);
    expect(list.find((r) => r.recordId === '0'.repeat(22))).toBeUndefined();
  });

  it('损坏数据读取抛错（fail-closed）', async () => {
    const m = mem();
    const s = new DeferredRecordStore(m, '7', '1');
    await m.update('devbelt.sync.deferred.7.1', { records: { [REC_ID]: { version: 'x' } } });
    expect(() => s.list()).toThrow();
  });
});