import { describe, expect, it } from 'vitest';
import { PendingMutationStore, type PendingPutMutation, type PendingDeleteMutation } from '../../../src/sync/e2e/pendingMutationStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function put(over: Partial<PendingPutMutation> = {}): PendingPutMutation {
  return {
    action: 'record.put', recordId: 'A'.repeat(22), connectionId: 'c-1', baseVersion: '0',
    mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
    signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), ...over,
  };
}

function del(over: Partial<PendingDeleteMutation> = {}): PendingDeleteMutation {
  return {
    action: 'record.delete', recordId: 'A'.repeat(22), connectionId: 'c-1', baseVersion: '3',
    mutationId: 'B'.repeat(22), signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43), ...over,
  };
}

describe('PendingMutationStore', () => {
  it('put/list/delete/clear 往返', async () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    const m = put();
    await s.put(m);
    expect(s.list()).toEqual([m]);
    await s.delete(m.mutationId);
    expect(s.list()).toEqual([]);
    await s.put(del({ mutationId: 'G'.repeat(22) }));
    await s.clear();
    expect(s.list()).toEqual([]);
  });

  it('delete mutation 落盘与读取', async () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    const d = del();
    await s.put(d);
    expect(s.list()).toEqual([d]);
  });

  it('delete mutation 禁止携带 nonce/ciphertext/tag', async () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    await expect(s.put({ ...del(), nonce: 'C'.repeat(16) } as never)).rejects.toThrowError(/must not carry nonce/);
    await expect(s.put({ ...del(), ciphertext: 'YQ' } as never)).rejects.toThrowError(/must not carry ciphertext/);
  });

  it('拒绝 org: connectionId 入 outbox', async () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    await expect(s.put(put({ connectionId: 'org:1:2' }))).rejects.toThrowError(/organization/);
  });

  it('拒绝非法 mutationId 长度', async () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    await expect(s.put(put({ mutationId: 'short' }))).rejects.toThrowError(/mutationId/);
  });

  it('串行化并发写入，避免丢失 mutation', async () => {
    const m = new Map<string, unknown>();
    let releaseFirst!: () => void;
    const firstUpdate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstUpdateStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstUpdateStarted = resolve; });
    let updates = 0;
    const s = new PendingMutationStore({
      get: <T>(key: string): T | undefined => m.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        if (updates++ === 0) {
          firstUpdateStarted();
          await firstUpdate;
        }
        m.set(key, value);
      },
    }, '7', '1');

    const first = s.put(put());
    await started;
    const second = s.put(put({ recordId: 'C'.repeat(22), connectionId: 'c-2', mutationId: 'G'.repeat(22) }));
    releaseFirst();
    await Promise.all([first, second]);

    expect(s.list()).toHaveLength(2);
  });
});
