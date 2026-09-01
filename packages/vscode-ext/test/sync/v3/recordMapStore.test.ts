import { describe, expect, it } from 'vitest';
import { RecordMapStore } from '../../../src/sync/v3/recordMapStore';

function makeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

describe('RecordMapStore', () => {
  it('双向映射 put/get 往返', () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '3', revision: 100 });
    expect(s.getByRecordId('A'.repeat(22))).toEqual({ recordId: 'A'.repeat(22), connectionId: 'c-1', recordVersion: '3', revision: 100 });
    expect(s.getByConnectionId('c-1')!.recordId).toBe('A'.repeat(22));
  });

  it('userId/keyEpoch 隔离', () => {
    const a = new RecordMapStore(makeMemento(), '7', '1');
    const b = new RecordMapStore(makeMemento(), '8', '1');
    const c = new RecordMapStore(makeMemento(), '7', '2');
    a.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0 });
    expect(b.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(c.getByRecordId('A'.repeat(22))).toBeUndefined();
  });

  it('拒绝 org: connectionId 入映射', () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    expect(() => s.put('A'.repeat(22), { connectionId: 'org:1:2', recordVersion: '1', revision: 0 })).toThrowError(/organization/);
  });

  it('deleteByRecordId 清双向', () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0 });
    s.deleteByRecordId('A'.repeat(22));
    expect(s.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(s.getByConnectionId('c-1')).toBeUndefined();
  });
});