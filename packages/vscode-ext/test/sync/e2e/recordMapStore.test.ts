import { describe, expect, it } from 'vitest';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';

function makeMemento(seed?: Record<string, unknown>) {
  const m = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

describe('RecordMapStore', () => {
  it('双向映射 put/get 往返', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '3', revision: 100, status: 'confirmed' });
    expect(s.getByRecordId('A'.repeat(22))).toEqual({ recordId: 'A'.repeat(22), connectionId: 'c-1', recordVersion: '3', revision: 100, status: 'confirmed' });
    expect(s.getByConnectionId('c-1')!.recordId).toBe('A'.repeat(22));
  });

  it('userId/keyEpoch 隔离', async () => {
    const a = new RecordMapStore(makeMemento(), '7', '1');
    const b = new RecordMapStore(makeMemento(), '8', '1');
    const c = new RecordMapStore(makeMemento(), '7', '2');
    await a.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    expect(b.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(c.getByRecordId('A'.repeat(22))).toBeUndefined();
  });

  it('拒绝 org: connectionId 入映射', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await expect(s.put('A'.repeat(22), { connectionId: 'org:1:2', recordVersion: '1', revision: 0, status: 'confirmed' })).rejects.toThrowError(/organization/);
  });

  it('deleteByRecordId 清双向', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.deleteByRecordId('A'.repeat(22));
    expect(s.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(s.getByConnectionId('c-1')).toBeUndefined();
  });

  it('record 换 connectionId 时清旧反向指针（双射不变量）', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('A'.repeat(22), { connectionId: 'c-2', recordVersion: '2', revision: 0, status: 'confirmed' });
    expect(s.getByConnectionId('c-1')).toBeUndefined();
    expect(s.getByConnectionId('c-2')!.recordId).toBe('A'.repeat(22));
  });

  it('connectionId 被其他 record 占用 fail-closed', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('B'.repeat(22), { connectionId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' });
    await expect(s.put('B'.repeat(22), { connectionId: 'c-1', recordVersion: '2', revision: 0, status: 'confirmed' })).rejects.toThrowError(/mapped/);
    expect(s.getByConnectionId('c-1')!.recordId).toBe('A'.repeat(22));
    expect(s.getByConnectionId('c-2')!.recordId).toBe('B'.repeat(22));
  });

  it('串行化并发写入，避免丢失映射', async () => {
    const m = new Map<string, unknown>();
    let releaseFirst!: () => void;
    const firstUpdate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstUpdateStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstUpdateStarted = resolve; });
    let updates = 0;
    const s = new RecordMapStore({
      get: <T>(key: string): T | undefined => m.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        if (updates++ === 0) {
          firstUpdateStarted();
          await firstUpdate;
        }
        m.set(key, value);
      },
    }, '7', '1');

    const first = s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await started;
    const second = s.put('B'.repeat(22), { connectionId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' });
    releaseFirst();
    await Promise.all([first, second]);

    expect(s.getByRecordId('A'.repeat(22))?.connectionId).toBe('c-1');
    expect(s.getByRecordId('B'.repeat(22))?.connectionId).toBe('c-2');
  });

  it('deleteByRecordId 持久化失败不污染内存视图', async () => {
    const m = new Map<string, unknown>();
    let fail = false;
    const s = new RecordMapStore({
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        if (fail) throw new Error('write failed');
        m.set(k, v);
      },
    }, '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    fail = true;
    await expect(s.deleteByRecordId('A'.repeat(22))).rejects.toThrowError(/write failed/);
    expect(s.getByRecordId('A'.repeat(22))?.connectionId).toBe('c-1');
    expect(s.getByConnectionId('c-1')?.recordId).toBe('A'.repeat(22));
  });

  it('deleteByConnectionId 持久化失败不污染内存视图', async () => {
    const m = new Map<string, unknown>();
    let fail = false;
    const s = new RecordMapStore({
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        if (fail) throw new Error('write failed');
        m.set(k, v);
      },
    }, '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    fail = true;
    await expect(s.deleteByConnectionId('c-1')).rejects.toThrowError(/write failed/);
    expect(s.getByRecordId('A'.repeat(22))?.connectionId).toBe('c-1');
    expect(s.getByConnectionId('c-1')?.recordId).toBe('A'.repeat(22));
  });

  it('首个写失败后仍可继续写', async () => {
    const m = new Map<string, unknown>();
    let fail = false;
    const s = new RecordMapStore({
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        if (fail) throw new Error('boom');
        m.set(k, v);
      },
    }, '7', '1');
    await s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    fail = true;
    await expect(s.put('B'.repeat(22), { connectionId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' })).rejects.toThrowError(/boom/);
    fail = false;
    await s.put('C'.repeat(22), { connectionId: 'c-3', recordVersion: '1', revision: 0, status: 'confirmed' });
    expect(s.getByRecordId('B'.repeat(22))).toBeUndefined();
    expect(s.getByRecordId('C'.repeat(22))?.connectionId).toBe('c-3');
  });

  it('阻塞 put 后紧随 delete 顺序正确', async () => {
    const m = new Map<string, unknown>();
    let releaseFirst!: () => void;
    const firstUpdate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstUpdateStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstUpdateStarted = resolve; });
    let updates = 0;
    const s = new RecordMapStore({
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        if (updates++ === 0) {
          firstUpdateStarted();
          await firstUpdate;
        }
        m.set(k, v);
      },
    }, '7', '1');

    const putPromise = s.put('A'.repeat(22), { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await started;
    const deletePromise = s.deleteByRecordId('A'.repeat(22));
    releaseFirst();
    await Promise.all([putPromise, deletePromise]);

    expect(s.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(s.getByConnectionId('c-1')).toBeUndefined();
  });

  it('read 对损坏形状 fail-closed', () => {
    const key = 'dbclient.sync.recordMap.7.1';

    const nonObject = new RecordMapStore(makeMemento({ [key]: 'garbage' }), '7', '1');
    expect(() => nonObject.getByRecordId('A'.repeat(22))).toThrowError(/corrupt record map/);

    const missingMaps = new RecordMapStore(makeMemento({ [key]: { byRecordId: null, byConnectionId: {} } }), '7', '1');
    expect(() => missingMaps.getByConnectionId('c-1')).toThrowError(/corrupt record map/);

    const badEntry = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { ['A'.repeat(22)]: { connectionId: 'c-1', recordVersion: '1', revision: 'bad' } }, byConnectionId: {} },
    }), '7', '1');
    expect(() => badEntry.getByRecordId('A'.repeat(22))).toThrowError(/corrupt record map/);
  });

  it('read 对语义非法值与反向索引错配 fail-closed', () => {
    const key = 'dbclient.sync.recordMap.7.1';
    const rid = 'A'.repeat(22);

    // 组织 connectionId 入映射
    const orgConn = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { connectionId: 'org:x', recordVersion: '1', revision: 0, status: 'confirmed' } }, byConnectionId: { 'org:x': rid } },
    }), '7', '1');
    expect(() => orgConn.getByRecordId(rid)).toThrowError(/organization/);

    // recordVersion 非法
    const badVersion = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { connectionId: 'c-1', recordVersion: 'x', revision: 0, status: 'confirmed' } }, byConnectionId: { 'c-1': rid } },
    }), '7', '1');
    expect(() => badVersion.getByRecordId(rid)).toThrowError(/recordVersion/);

    // 反向索引把 recordId 指到别处（双射破坏）
    const mismatch = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { connectionId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' } }, byConnectionId: { 'c-1': 'B'.repeat(22) } },
    }), '7', '1');
    expect(() => mismatch.getByRecordId(rid)).toThrowError(/corrupt record map/);
  });
});
