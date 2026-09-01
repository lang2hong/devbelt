import { describe, expect, it } from 'vitest';
import { PendingMutationStore, type PendingMutation } from '../../../src/sync/v3/pendingMutationStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

function pending(over: Partial<PendingMutation> = {}): PendingMutation {
  return {
    action: 'record.put', recordId: 'A'.repeat(22), connectionId: 'c-1', baseVersion: '0',
    mutationId: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'YQ', tag: 'D'.repeat(22),
    signature: 'E'.repeat(86), requestDigest: 'F'.repeat(43),
    ...over,
  };
}

describe('PendingMutationStore', () => {
  it('put/list/delete/clear 往返', () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    const m = pending();
    s.put(m);
    expect(s.list()).toEqual([m]);
    s.delete(m.mutationId);
    expect(s.list()).toEqual([]);
    s.put(pending({ mutationId: 'G'.repeat(22) }));
    s.clear();
    expect(s.list()).toEqual([]);
  });

  it('拒绝 org: connectionId 入 outbox', () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    expect(() => s.put(pending({ connectionId: 'org:1:2' }))).toThrowError(/organization/);
  });

  it('拒绝非法 mutationId 长度', () => {
    const s = new PendingMutationStore(makeMemento(), '7', '1');
    expect(() => s.put(pending({ mutationId: 'short' }))).toThrowError(/mutationId/);
  });
});