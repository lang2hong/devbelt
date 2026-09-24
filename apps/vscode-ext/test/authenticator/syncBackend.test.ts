import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { AuthenticatorStore } from '../../src/authenticator/store';
import { AuthenticatorSyncBackend } from '../../src/authenticator/syncBackend';
import type { SyncEntityRef } from '@devbelt/db-host/sync/e2e/syncEntity';

function memento() {
  const store = new Map<string, unknown>();
  return {
    map: store,
    keys: () => Array.from(store.keys()),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    update: async (k: string, v: unknown) => { store.set(k, v); },
  };
}
function secrets() {
  const map = new Map<string, string>();
  return {
    map,
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) { map.delete(k); },
    onDidChange() { return { dispose() { /* noop */ } }; },
  };
}
const auth = () => ({ isLoggedIn: () => false, getCachedEntitlement: () => undefined });

describe('P6 墓碑与 AuthenticatorSyncBackend', () => {
  let mem: ReturnType<typeof memento>;
  let sec: ReturnType<typeof secrets>;
  let store: AuthenticatorStore;
  let backend: AuthenticatorSyncBackend;

  beforeEach(async () => {
    mem = memento();
    sec = secrets();
    store = new AuthenticatorStore(mem, sec as never, auth());
    await store.init();
    backend = new AuthenticatorSyncBackend(store);
  });
  afterEach(() => store.dispose());

  it('deleteEntry 置墓碑：UI 不可见，同步读面可见 deleted+updateTime', async () => {
    const added = await store.addEntry({ issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' });
    if (!added.ok) throw new Error('add failed');
    await store.deleteEntry(added.entry.id);
    expect(store.listEntries().some((e) => e.id === added.entry.id)).toBe(false);
    const tomb = store.listEntriesForSync().find((e) => e.id === added.entry.id);
    expect(tomb?.deleted).toBe(true);
    expect(typeof tomb?.updateTime).toBe('number');
    const rec = backend.listForSync().find((r) => r.ref.localId === added.entry.id);
    expect(rec?.deleted).toBe(true);
  });

  it('deleteGroup/deleteTag 置墓碑且同步读面可见', async () => {
    const g = await store.addGroup('G');
    const t = await store.addTag('T', 'blue');
    if (!g.ok || !t.ok) throw new Error('setup failed');
    await store.deleteGroup(g.group.id);
    await store.deleteTag(t.tag.id);
    expect(store.listGroups().length).toBe(0);
    expect(store.listTags().length).toBe(0);
    expect(backend.listForSync().find((r) => r.ref.localId === g.group.id)?.deleted).toBe(true);
    expect(backend.listForSync().find((r) => r.ref.localId === t.tag.id)?.deleted).toBe(true);
  });

  it('backend.save(entry) 写 secret+元数据；get 返回带 updateTime 与 secret', async () => {
    const ref: SyncEntityRef = { type: 'authenticatorEntry', localId: 'ae-sync' };
    await backend.save(ref, {
      id: 'ae-sync', issuer: 'Acme', account: 'a', algorithm: 'SHA1', digits: 6, period: 30,
      tags: [], createTime: 1, updateTime: 1, secret: 'JBSWY3DPEHPK3PXP',
    } as never, 'sync');
    const got = backend.get(ref) as { issuer?: string; updateTime?: number; secret?: string } | undefined;
    expect(got?.issuer).toBe('Acme');
    expect(typeof got?.updateTime).toBe('number');
    expect(got?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(sec.map.get('devbelt.authenticator.ae-sync.secret')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('backend.save 要求 entry 携带 secret（fail-closed）', async () => {
    const ref: SyncEntityRef = { type: 'authenticatorEntry', localId: 'ae-nosecret' };
    await expect(backend.save(ref, { id: 'ae-nosecret', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 1, updateTime: 1 } as never, 'sync')).rejects.toThrow(/secret/);
  });

  it('backend.save(group/tag) 后 get 返回数值 updateTime', async () => {
    await backend.save({ type: 'authenticatorGroup', localId: 'ag-1' }, { id: 'ag-1', name: 'G', sortOrder: 10 } as never, 'sync');
    await backend.save({ type: 'authenticatorTag', localId: 'at-1' }, { id: 'at-1', name: 'T', color: 'cyan' } as never, 'sync');
    const g = backend.get({ type: 'authenticatorGroup', localId: 'ag-1' }) as { updateTime?: number } | undefined;
    const t = backend.get({ type: 'authenticatorTag', localId: 'at-1' }) as { updateTime?: number } | undefined;
    expect(typeof g?.updateTime).toBe('number');
    expect(typeof t?.updateTime).toBe('number');
  });

  it('backend.remove 硬删（墓碑落地幂等）', async () => {
    await backend.save({ type: 'authenticatorTag', localId: 'at-2' }, { id: 'at-2', name: 'T', color: 'red' } as never, 'sync');
    await backend.remove({ type: 'authenticatorTag', localId: 'at-2' }, 'sync');
    expect(backend.get({ type: 'authenticatorTag', localId: 'at-2' })).toBeUndefined();
    await expect(backend.remove({ type: 'authenticatorTag', localId: 'at-2' }, 'sync')).resolves.toBeUndefined();
  });
});
