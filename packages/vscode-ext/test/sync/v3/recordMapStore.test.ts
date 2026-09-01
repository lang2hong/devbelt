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
  it('双向映射 put/get 往返', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '3', revision: 100 });
    expect(s.getByRecordId('A'.repeat(22))).toEqual({ recordId: 'A'.repeat(22), connectionId: 'c-1', recordVersion: '3', revision: 100 });
    expect(s.getByConnectionId('c-1')!.recordId).toBe('A'.repeat(22));
  });

  it('userId/keyEpoch 隔离', async () => {
    const a = new RecordMapStore(makeMemento(), '7', '1');
    const b = new RecordMapStore(makeMemento(), '8', '1');
    const c = new RecordMapStore(makeMemento(), '7', '2');
    await a.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0 });
    expect(b.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(c.getByRecordId('A'.repeat(22))).toBeUndefined();
  });

  it('拒绝 org: connectionId 入映射', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await expect(s.put('A'.repeat(22), { connectionId: 'org:1:2', recordVersion: '1', revision: 0 })).rejects.toThrowError(/organization/);
  });

  it('deleteByRecordId 清双向', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0 });
    await s.deleteByRecordId('A'.repeat(22));
    expect(s.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(s.getByConnectionId('c-1')).toBeUndefined();
  });

  it('record 换 connectionId 时清旧反向指针（双射不变量）', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0 });
    await s.put('A'.repeat(22), { connectionId: 'c-2', recordVersion: '2', revision: 0 });
    expect(s.getByConnectionId('c-1')).toBeUndefined();
    expect(s.getByConnectionId('c-2')!.recordId).toBe('A'.repeat(22));
  });

  it('connectionId 被其他 record 占用 fail-closed', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0 });
    await s.put('B'.repeat(22), { connectionId: 'c-2', recordVersion: '1', revision: 0 });
    await expect(s.put('B'.repeat(22), { connectionId: 'c-1', recordVersion: '2', revision: 0 })).rejects.toThrowError(/mapped/);
  });
});