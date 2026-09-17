import { describe, expect, it } from 'vitest';
import { RecordMapStore } from '../../../src/sync/e2e/recordMapStore';

function makeMemento(seed?: Record<string, unknown>) {
  const m = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
  };
}

const connectionRef = { type: 'connection', localId: 'c-1' } as const;

describe('RecordMapStore', () => {
  it('双向映射 put/get 往返（typed ref）', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '3', revision: 100, status: 'confirmed' });
    expect(s.getByRecordId('A'.repeat(22))).toEqual({ recordId: 'A'.repeat(22), type: 'connection', localId: 'c-1', recordVersion: '3', revision: 100, status: 'confirmed' });
    expect(s.getByRef(connectionRef)!.recordId).toBe('A'.repeat(22));
  });

  it('userId/keyEpoch 隔离', async () => {
    const a = new RecordMapStore(makeMemento(), '7', '1');
    const b = new RecordMapStore(makeMemento(), '8', '1');
    const c = new RecordMapStore(makeMemento(), '7', '2');
    await a.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    expect(b.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(c.getByRecordId('A'.repeat(22))).toBeUndefined();
  });

  it('拒绝 org: connection 入映射；其他类型不受 org 前缀限制', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await expect(s.put('A'.repeat(22), { type: 'connection', localId: 'org:1:2', recordVersion: '1', revision: 0, status: 'confirmed' })).rejects.toThrowError(/organization/);
    // query 类型 localId 含 org: 前缀不应被误判为组织连接。
    await s.put('B'.repeat(22), { type: 'query', localId: 'org-like-query', recordVersion: '1', revision: 0, status: 'confirmed' });
    expect(s.getByRecordId('B'.repeat(22))!.localId).toBe('org-like-query');
  });

  it('deleteByRecordId 清双向', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.deleteByRecordId('A'.repeat(22));
    expect(s.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(s.getByRef(connectionRef)).toBeUndefined();
  });

  it('record 换 localId 时清旧反向指针（双射不变量）', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-2', recordVersion: '2', revision: 0, status: 'confirmed' });
    expect(s.getByRef({ type: 'connection', localId: 'c-1' })).toBeUndefined();
    expect(s.getByRef({ type: 'connection', localId: 'c-2' })!.recordId).toBe('A'.repeat(22));
  });

  it('local entity 被其他 record 占用 fail-closed', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('B'.repeat(22), { type: 'connection', localId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' });
    await expect(s.put('B'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '2', revision: 0, status: 'confirmed' })).rejects.toThrowError(/mapped/);
    expect(s.getByRef({ type: 'connection', localId: 'c-1' })!.recordId).toBe('A'.repeat(22));
    expect(s.getByRef({ type: 'connection', localId: 'c-2' })!.recordId).toBe('B'.repeat(22));
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

    const first = s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await started;
    const second = s.put('B'.repeat(22), { type: 'connection', localId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' });
    releaseFirst();
    await Promise.all([first, second]);

    expect(s.getByRecordId('A'.repeat(22))?.localId).toBe('c-1');
    expect(s.getByRecordId('B'.repeat(22))?.localId).toBe('c-2');
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
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    fail = true;
    await expect(s.deleteByRecordId('A'.repeat(22))).rejects.toThrowError(/write failed/);
    expect(s.getByRecordId('A'.repeat(22))?.localId).toBe('c-1');
    expect(s.getByRef(connectionRef)?.recordId).toBe('A'.repeat(22));
  });

  it('deleteByRef 持久化失败不污染内存视图', async () => {
    const m = new Map<string, unknown>();
    let fail = false;
    const s = new RecordMapStore({
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      update: async (k: string, v: unknown): Promise<void> => {
        if (fail) throw new Error('write failed');
        m.set(k, v);
      },
    }, '7', '1');
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    fail = true;
    await expect(s.deleteByRef(connectionRef)).rejects.toThrowError(/write failed/);
    expect(s.getByRecordId('A'.repeat(22))?.localId).toBe('c-1');
    expect(s.getByRef(connectionRef)?.recordId).toBe('A'.repeat(22));
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
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    fail = true;
    await expect(s.put('B'.repeat(22), { type: 'connection', localId: 'c-2', recordVersion: '1', revision: 0, status: 'confirmed' })).rejects.toThrowError(/boom/);
    fail = false;
    await s.put('C'.repeat(22), { type: 'connection', localId: 'c-3', recordVersion: '1', revision: 0, status: 'confirmed' });
    expect(s.getByRecordId('B'.repeat(22))).toBeUndefined();
    expect(s.getByRecordId('C'.repeat(22))?.localId).toBe('c-3');
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

    const putPromise = s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await started;
    const deletePromise = s.deleteByRecordId('A'.repeat(22));
    releaseFirst();
    await Promise.all([putPromise, deletePromise]);

    expect(s.getByRecordId('A'.repeat(22))).toBeUndefined();
    expect(s.getByRef(connectionRef)).toBeUndefined();
  });

  it('read 对损坏形状 fail-closed', () => {
    const key = 'dbclient.sync.recordMap.7.1';

    const nonObject = new RecordMapStore(makeMemento({ [key]: 'garbage' }), '7', '1');
    expect(() => nonObject.getByRecordId('A'.repeat(22))).toThrowError(/corrupt record map/);

    const missingMaps = new RecordMapStore(makeMemento({ [key]: { byRecordId: null, byLocal: {} } }), '7', '1');
    expect(() => missingMaps.getByRef(connectionRef)).toThrowError(/corrupt record map/);

    const badEntry = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { ['A'.repeat(22)]: { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 'bad' } }, byLocal: {} },
    }), '7', '1');
    expect(() => badEntry.getByRecordId('A'.repeat(22))).toThrowError(/corrupt record map/);
  });

  it('read 对语义非法值与反向索引错配 fail-closed', () => {
    const key = 'dbclient.sync.recordMap.7.1';
    const rid = 'A'.repeat(22);

    const orgConn = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { type: 'connection', localId: 'org:x', recordVersion: '1', revision: 0, status: 'confirmed' } }, byLocal: { 'connection:org:x': rid } },
    }), '7', '1');
    expect(() => orgConn.getByRecordId(rid)).toThrowError(/organization/);

    const badVersion = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { type: 'connection', localId: 'c-1', recordVersion: 'x', revision: 0, status: 'confirmed' } }, byLocal: { 'connection:c-1': rid } },
    }), '7', '1');
    expect(() => badVersion.getByRecordId(rid)).toThrowError(/recordVersion/);

    const mismatch = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' } }, byLocal: { 'connection:c-1': 'B'.repeat(22) } },
    }), '7', '1');
    expect(() => mismatch.getByRecordId(rid)).toThrowError(/corrupt record map/);
  });

  it('缺失 status 抛错（fail-closed）', () => {
    const key = 'dbclient.sync.recordMap.7.1';
    const rid = 'A'.repeat(22);
    const s = new RecordMapStore(makeMemento({
      [key]: { byRecordId: { [rid]: { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 42 } }, byLocal: { 'connection:c-1': rid } },
    }), '7', '1');
    expect(() => s.getByRecordId(rid)).toThrowError(/corrupt record map/);
  });

  it('四种类型共享同一双射且互不冲突（跨类型不变量）', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { type: 'group', localId: 'g-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('B'.repeat(22), { type: 'queryFolder', localId: 'qf-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('C'.repeat(22), { type: 'query', localId: 'q-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('D'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    expect(s.getByRef({ type: 'group', localId: 'g-1' })!.recordId).toBe('A'.repeat(22));
    expect(s.getByRef({ type: 'queryFolder', localId: 'qf-1' })!.recordId).toBe('B'.repeat(22));
    expect(s.getByRef({ type: 'query', localId: 'q-1' })!.recordId).toBe('C'.repeat(22));
    expect(s.getByRef(connectionRef)!.recordId).toBe('D'.repeat(22));
  });

  it('list() 返回全部映射条目（含 recordId）', async () => {
    const s = new RecordMapStore(makeMemento(), '7', '1');
    await s.put('A'.repeat(22), { type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' });
    await s.put('B'.repeat(22), { type: 'query', localId: 'q-1', recordVersion: '2', revision: 5, status: 'pending' });

    const entries = s.list();
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      { recordId: 'A'.repeat(22), type: 'connection', localId: 'c-1', recordVersion: '1', revision: 0, status: 'confirmed' },
      { recordId: 'B'.repeat(22), type: 'query', localId: 'q-1', recordVersion: '2', revision: 5, status: 'pending' },
    ]));
  });
});