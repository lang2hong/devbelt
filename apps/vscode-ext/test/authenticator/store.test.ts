import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AuthenticatorStore } from '../../src/authenticator/store';
import { ENTRIES_KEY, GROUPS_KEY } from '../../src/authenticator/types';
import { encodeBase32UpperCaseNoPadding } from '@devbelt/db-host/authenticator/base32';

/** In-memory Memento stub (Map-backed, same shape as vscode.Memento). */
function memento() {
  const store = new Map<string, unknown>();
  return {
    map: store,
    keys: () => Array.from(store.keys()),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    update: async (k: string, v: unknown) => { store.set(k, v); },
  };
}

/** In-memory SecretStorage stub with onDidChange emitter. delete 对不存在的 key 也 resolve（对齐真实 vscode）。 */
function secretsWithEvents() {
  const map = new Map<string, string>();
  const listeners: Array<(e: { key: string }) => void> = [];
  return {
    map,
    emit: (key: string) => listeners.forEach((l) => l({ key })),
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) { map.delete(k); },
    onDidChange(l: (e: { key: string }) => void) { listeners.push(l); return { dispose() { /* no-op */ } }; },
  };
}

function auth(loggedIn = false, limit?: number) {
  return {
    isLoggedIn: () => loggedIn,
    getCachedEntitlement: () => loggedIn ? (limit !== undefined ? {
      planCode: 'pro', allowedDatabaseTypes: [], maxDevices: 0, maxSavedConnections: 10,
      allowConnectionImport: true, maxAuthenticatorEntries: limit,
    } : undefined) : undefined,
  };
}

describe('AuthenticatorStore', () => {
  let mem: ReturnType<typeof memento>;
  let sec: ReturnType<typeof secretsWithEvents>;
  let store: AuthenticatorStore;

  beforeEach(async () => {
    mem = memento();
    sec = secretsWithEvents();
    store = new AuthenticatorStore(mem, sec as never, auth(false));
    await store.init();
  });

  afterEach(() => {
    store.dispose();
  });

  it('addEntry persists metadata and canonicalizes secret', async () => {
    const result = await store.addEntry({
      issuer: 'Acme', account: 'alice', secret: ' jbs wy3dp ', algorithm: 'SHA1', digits: 6, period: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('add failed');
    const e = result.entry;
    expect(e.id.startsWith('ae-')).toBe(true);
    expect(e.issuer).toBe('Acme');
    expect(e.account).toBe('alice');
    expect(e.algorithm).toBe('SHA1');
    // secret should be normalized in cache
    expect(store.getSecret(e.id)).toBeDefined();
    expect(store.getSecret(e.id)).not.toContain(' ');
    expect(store.getSecret(e.id)).toBe(store.getSecret(e.id)!.toUpperCase());
  });

  it('addEntry quota: logged-in with limit returns quota error', async () => {
    store.dispose();
    store = new AuthenticatorStore(mem, sec as never, auth(true, 2));
    await store.init();
    for (let i = 0; i < 2; i++) {
      const r = await store.addEntry({ issuer: 'A', account: `u${i}`, secret: 'JBSWY3DPEHPK3PXP' });
      expect(r.ok).toBe(true);
    }
    const r3 = await store.addEntry({ issuer: 'A', account: 'u2', secret: 'JBSWY3DPEHPK3PXP' });
    expect(r3.ok).toBe(false);
    expect((r3 as any).reason).toBe('quota');
    expect((r3 as any).limit).toBe(2);
  });

  it('addEntry quota: not logged-in unlimited', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await store.addEntry({ issuer: 'A', account: `u${i}`, secret: 'JBSWY3DPEHPK3PXP' });
      expect(r.ok).toBe(true);
    }
  });

  it('addEntry quota: limit 0 means unlimited even when logged in', async () => {
    store.dispose();
    store = new AuthenticatorStore(mem, sec as never, auth(true, 0));
    await store.init();
    for (let i = 0; i < 25; i++) {
      const r = await store.addEntry({ issuer: 'A', account: `u${i}`, secret: 'JBSWY3DPEHPK3PXP' });
      expect(r.ok).toBe(true);
    }
  });

  it('addEntry rejects empty / whitespace-only / padding-only secret', async () => {
    for (const secret of ['', '   ', '\t\n', '====', '  ==  ']) {
      const r = await store.addEntry({ issuer: 'A', account: 'a', secret });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected invalidSecret');
      expect(r.reason).toBe('invalidSecret');
    }
  });

  it('updateEntry: empty / whitespace-only secret keeps old secret (contract), still updates metadata', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = store.getSecret(add.entry.id);
    for (const s of ['', '   ', '\t\n']) {
      const upd = await store.updateEntry(add.entry.id, { secret: s, issuer: 'A2' });
      expect(upd.ok).toBe(true);
      expect(store.getSecret(add.entry.id)).toBe(before);
    }
    expect(store.listEntries().find((e) => e.id === add.entry.id)!.issuer).toBe('A2');
  });

  it('updateEntry: omitted secret keeps old secret', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = store.getSecret(add.entry.id);
    const upd = await store.updateEntry(add.entry.id, { issuer: 'B', account: 'b' });
    expect(upd.ok).toBe(true);
    expect(store.getSecret(add.entry.id)).toBe(before);
  });

  it('updateEntry: non-empty but invalid secret is rejected and leaves old secret intact', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = store.getSecret(add.entry.id);
    for (const bad of ['000', '====', 'hello0']) {
      const upd = await store.updateEntry(add.entry.id, { secret: bad });
      expect(upd.ok).toBe(false);
      if (upd.ok) throw new Error('expected invalidSecret');
      expect(upd.reason).toBe('invalidSecret');
    }
    expect(store.getSecret(add.entry.id)).toBe(before);
  });

  it('updateEntry: notFound for unknown id', async () => {
    const upd = await store.updateEntry('nope', { issuer: 'X' });
    expect(upd.ok).toBe(false);
    if (upd.ok) throw new Error('expected notFound');
    expect(upd.reason).toBe('notFound');
  });

  it('updateEntry clamps out-of-range digits/period (IPC trust boundary)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const upd = await store.updateEntry(add.entry.id, { digits: 7 as any, period: 45 as any });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(upd.entry.digits).toBe(6);
    expect(upd.entry.period).toBe(30);
    // and the code produced respects the clamp
    const code = store.getCodes([add.entry.id], Date.now())[add.entry.id]?.code;
    expect(code).toMatch(/^\d{6}$/);
  });

  it('addEntry invalid secret returns invalidSecret', async () => {
    const r = await store.addEntry({ issuer: 'A', account: 'a', secret: '000' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invalidSecret');
    expect(r.reason).toBe('invalidSecret');
  });

  it('init warms secretCache; getCodes does NOT call secrets.get', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    // Build fresh store to exercise init warmup
    store.dispose();
    const store2 = new AuthenticatorStore(mem, sec as never, auth(false));
    const getSpy = vi.spyOn(sec, 'get');
    await store2.init();
    expect(getSpy).toHaveBeenCalled(); // called during init
    getSpy.mockClear();
    const codes = store2.getCodes([add.entry.id], Date.now());
    expect(getSpy).not.toHaveBeenCalled(); // getCodes must not touch secrets API
    expect(codes[add.entry.id]).toBeDefined();
    expect(codes[add.entry.id].code).toMatch(/^\d{6}$/);
    store2.dispose();
  });

  it('getCodes returns no entry for missing secret', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    // Simulate missing secret by deleting from backing map directly (emulates external deletion)
    sec.map.clear();
    // Build new store; init will mark missing
    store.dispose();
    const store2 = new AuthenticatorStore(mem, sec as never, auth(false));
    await store2.init();
    expect(store2.isSecretMissing(add.entry.id)).toBe(true);
    const codes = store2.getCodes([add.entry.id], Date.now());
    expect(codes[add.entry.id]).toBeUndefined();
    store2.dispose();
  });

  it('deleteEntry: secret delete fails → memento unchanged (transaction order)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    vi.spyOn(sec, 'delete').mockRejectedValueOnce(new Error('keychain locked'));
    const del = await store.deleteEntry(add.entry.id);
    expect(del.ok).toBe(false);
    // entry still listed
    expect(store.listEntries().some((e) => e.id === add.entry.id)).toBe(true);
    // cache still populated
    expect(store.getSecret(add.entry.id)).toBeDefined();
  });

  it('markSyncError/clearSyncError toggle localOnly+syncError', async () => {
    const added = await store.addEntry({ issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' });
    if (!added.ok) throw new Error('add failed');
    await store.markSyncError(added.entry.id, 'quota');
    const marked = store.listEntries().find((e) => e.id === added.entry.id);
    expect(marked?.localOnly).toBe(true);
    expect(marked?.syncError).toBe('quota');
    await store.clearSyncError(added.entry.id);
    const cleared = store.listEntries().find((e) => e.id === added.entry.id);
    expect(cleared?.localOnly).toBe(false);
    expect(cleared?.syncError).toBeUndefined();
  });

  it('upsertFromSync writes explicit id, canonicalizes secret, persists metadata', async () => {
    await store.upsertFromSync({
      id: 'ae_sync_1', issuer: 'Sync', account: 'a', algorithm: 'SHA256', digits: 8, period: 60,
      groupId: undefined, tags: [], createTime: 111, updateTime: 222,
    }, ' jbs wy3dp ');
    const stored = store.listEntries().find((e) => e.id === 'ae_sync_1');
    expect(stored?.issuer).toBe('Sync');
    expect(stored?.digits).toBe(8);
    expect(stored?.period).toBe(60);
    expect(store.getSecret('ae_sync_1')).toBeTruthy();
    expect(sec.map.get('devbelt.authenticator.ae_sync_1.secret')).toBe(store.getSecret('ae_sync_1'));

    // 跨重启可见（写入 memento）
    const mem2 = memento();
    for (const k of mem.keys()) await mem2.update(k, mem.get(k));
    const store2 = new AuthenticatorStore(mem2, sec as never, auth(false));
    await store2.init();
    expect(store2.listEntries().some((e) => e.id === 'ae_sync_1')).toBe(true);
    store2.dispose();
  });

  it('upsertFromSync overwrites an existing entry by id (no duplicate)', async () => {
    const base = { issuer: 'A', algorithm: 'SHA1' as const, digits: 6 as const, period: 30 as const, tags: [], createTime: 1, updateTime: 1 };
    await store.upsertFromSync({ id: 'ae_sync_2', ...base }, 'JBSWY3DPEHPK3PXP');
    await store.upsertFromSync({ id: 'ae_sync_2', ...base, issuer: 'B', updateTime: 2 }, 'JBSWY3DPEHPK3PXP');
    const matches = store.listEntries().filter((e) => e.id === 'ae_sync_2');
    expect(matches).toHaveLength(1);
    expect(matches[0].issuer).toBe('B');
  });

  it('upsertFromSync bypasses local quota', async () => {
    const mem2 = memento();
    const sec2 = secretsWithEvents();
    const capped = new AuthenticatorStore(mem2, sec2 as never, auth(true, 1));
    await capped.init();
    expect((await capped.addEntry({ issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' })).ok).toBe(true);
    expect((await capped.addEntry({ issuer: 'B', secret: 'JBSWY3DPEHPK3PXP' })).ok).toBe(false);
    await capped.upsertFromSync({
      id: 'ae_sync_3', issuer: 'C', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 1, updateTime: 1,
    }, 'JBSWY3DPEHPK3PXP');
    expect(capped.listEntries().some((e) => e.id === 'ae_sync_3')).toBe(true);
    capped.dispose();
  });

  it('removeFromSync deletes by id and is idempotent', async () => {
    await store.upsertFromSync({
      id: 'ae_sync_4', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 1, updateTime: 1,
    }, 'JBSWY3DPEHPK3PXP');
    await store.removeFromSync('ae_sync_4');
    expect(store.listEntries().some((e) => e.id === 'ae_sync_4')).toBe(false);
    expect(sec.map.has('devbelt.authenticator.ae_sync_4.secret')).toBe(false);
    await expect(store.removeFromSync('ae_sync_4')).resolves.toBeUndefined();
  });

  it('upsertFromSync rejects empty id / invalid secret', async () => {
    const base = { issuer: 'A', algorithm: 'SHA1' as const, digits: 6 as const, period: 30 as const, tags: [], createTime: 1, updateTime: 1 };
    await expect(store.upsertFromSync({ id: '', ...base }, 'JBSWY3DPEHPK3PXP')).rejects.toThrow();
    await expect(store.upsertFromSync({ id: 'ae_sync_5', ...base }, '0189')).rejects.toThrow();
  });

  it('deleteEntry: success clears cache and memento', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const del = await store.deleteEntry(add.entry.id);
    expect(del.ok).toBe(true);
    expect(store.listEntries().some((e) => e.id === add.entry.id)).toBe(false);
    expect(store.getSecret(add.entry.id)).toBeUndefined();
  });

  it('secrets.onDidChange: authenticator prefix parsed correctly; cache keyed by entry id (not full secret key)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = store.getCodes([add.entry.id], Date.now())[add.entry.id]?.code;
    // Simulate external secret update via full SecretStorage key
    const newNorm = encodeBase32UpperCaseNoPadding(new TextEncoder().encode('different-secret-1'));
    sec.map.set(`devbelt.authenticator.${add.entry.id}.secret`, newNorm);
    sec.emit(`devbelt.authenticator.${add.entry.id}.secret`);
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    // cache should now hold newNorm under entry id, not under full key
    expect(store.getSecret(add.entry.id)).toBe(newNorm);
    // No cache entry under the full SecretStorage key
    // (can't directly inspect secretCache, but getCodes should still work and use new value)
    const after = store.getCodes([add.entry.id], Date.now())[add.entry.id]?.code;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('secrets.onDidChange: non-authenticator keys ignored', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const before = store.getSecret(add.entry.id);
    sec.map.set('devbelt.connection.c1.password', 'whatever');
    sec.emit('devbelt.connection.c1.password');
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getSecret(add.entry.id)).toBe(before); // unchanged
  });

  it('secrets.onDidChange: undefined value marks missing', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    sec.map.delete(`devbelt.authenticator.${add.entry.id}.secret`);
    sec.emit(`devbelt.authenticator.${add.entry.id}.secret`);
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.isSecretMissing(add.entry.id)).toBe(true);
  });

  it('deleteGroup cascades: deletes member entries and their secrets (no ungrouped fallback)', async () => {
    const g = await store.addGroup('Work');
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.group.id });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(store.getSecret(add.entry.id)).toBeDefined();
    const dg = await store.deleteGroup(g.group.id);
    expect(dg.ok).toBe(true);
    expect(store.listEntries().find((e) => e.id === add.entry.id)).toBeUndefined();
    expect(store.getSecret(add.entry.id)).toBeUndefined();
    expect(sec.map.has(`devbelt.authenticator.${add.entry.id}.secret`)).toBe(false);
    expect(store.listGroups()).toHaveLength(0);
  });

  it('deleteGroup: secret delete failure keeps entry and re-homes it (no orphan secret)', async () => {
    const g = await store.addGroup('Work');
    const g2 = await store.addGroup('Other');
    if (!g.ok || !g2.ok) return;
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.group.id });
    if (!add.ok) return;
    const spy = vi.spyOn(sec, 'delete').mockRejectedValueOnce(new Error('keychain busy'));
    const dg = await store.deleteGroup(g.group.id);
    spy.mockRestore();
    expect(dg.ok).toBe(true);
    const e = store.listEntries().find((x) => x.id === add.entry.id);
    expect(e).toBeDefined();
    expect(e!.groupId).toBe(g2.group.id);
    expect(sec.map.has(`devbelt.authenticator.${add.entry.id}.secret`)).toBe(true);
  });

  it('init heals ungrouped/orphan entries into the first group', async () => {
    (mem.map as Map<string, unknown>).set(GROUPS_KEY, [{ id: 'ag1', name: 'G1', sortOrder: 10 }]);
    (mem.map as Map<string, unknown>).set(ENTRIES_KEY, [
      { id: 'ae1', issuer: 'A', algorithm: 'SHA1', digits: 6, period: 30, tags: [], groupId: undefined, createTime: 1, updateTime: 1 },
      { id: 'ae2', issuer: 'B', algorithm: 'SHA1', digits: 6, period: 30, tags: [], groupId: 'ghost', createTime: 1, updateTime: 1 },
    ]);
    store.dispose();
    store = new AuthenticatorStore(mem, sec as never, auth(false));
    await store.init();
    expect(store.listEntries().find((e) => e.id === 'ae1')!.groupId).toBe('ag1');
    expect(store.listEntries().find((e) => e.id === 'ae2')!.groupId).toBe('ag1');
  });

  it('creating the first group adopts pre-existing ungrouped entries', async () => {
    const add = await store.addEntry({ issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(store.listEntries().find((e) => e.id === add.entry.id)!.groupId).toBeUndefined();
    const g = await store.addGroup('First');
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(store.listEntries().find((e) => e.id === add.entry.id)!.groupId).toBe(g.group.id);
  });

  it('deleteTag removes tag id from entries', async () => {
    const t = await store.addTag('work', 'blue');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', tags: [t.tag.id] });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const dt = await store.deleteTag(t.tag.id);
    expect(dt.ok).toBe(true);
    const e = store.listEntries().find((x) => x.id === add.entry.id)!;
    expect(e.tags).toEqual([]);
  });

  it('addGroup/reorderGroup sortOrder properties', async () => {
    const g1 = await store.addGroup('A');
    const g2 = await store.addGroup('B');
    expect(g1.ok && g1.group.sortOrder).toBe(10);
    expect(g2.ok && g2.group.sortOrder).toBe(20);
    if (!g1.ok || !g2.ok) return;
    await store.reorderGroup([g2.group.id, g1.group.id]);
    const ordered = store.listGroups();
    expect(ordered.map((g) => g.id)).toEqual([g2.group.id, g1.group.id]);
    expect(ordered[0].sortOrder).toBe(10);
    expect(ordered[1].sortOrder).toBe(20);
  });

  it('addGroup rejects empty name with invalidName', async () => {
    const r = await store.addGroup('   ');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invalidName');
    expect(r.reason).toBe('invalidName');
  });

  it('addTag rejects non-whitelist colors', async () => {
    const r = await store.addTag('x', 'hotpink' as any);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invalidColor');
    expect(r.reason).toBe('invalidColor');
  });

  it('clearAll fault tolerance: failing secret delete keeps entry, and preserves groups/tags (no dangling refs)', async () => {
    const g = await store.addGroup('Work');
    const t = await store.addTag('work', 'blue');
    expect(g.ok && t.ok).toBe(true);
    if (!g.ok || !t.ok) return;
    const r1 = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.group.id, tags: [t.tag.id] });
    const r2 = await store.addEntry({ issuer: 'B', account: 'b', secret: 'JBSWY3DPEHPK3PXP', groupId: g.group.id, tags: [t.tag.id] });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Make second secret delete throw
    let call = 0;
    vi.spyOn(sec, 'delete').mockImplementation(async (k: string) => {
      call++;
      if (call === 2) throw new Error('delete failed');
      sec.map.delete(k);
    });
    const res = await store.clearAll();
    expect(res.failed).toHaveLength(1);
    // failed entry still in list, successful one removed
    const ids = store.listEntries().map((e) => e.id);
    expect(ids).not.toContain(r1.entry.id);
    expect(ids).toContain(r2.entry.id);
    // groups/tags preserved because not everything cleared → retained entry's refs stay valid
    expect(store.listGroups()).toHaveLength(1);
    expect(store.listTags()).toHaveLength(1);
    const retained = store.listEntries().find((e) => e.id === r2.entry.id)!;
    expect(retained.groupId).toBe(g.group.id);
    expect(retained.tags).toEqual([t.tag.id]);
  });

  it('clearAll: full success clears entries, groups and tags', async () => {
    const g = await store.addGroup('Work');
    const t = await store.addTag('work', 'blue');
    if (!g.ok || !t.ok) return;
    const r = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.group.id, tags: [t.tag.id] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await store.clearAll();
    expect(res.failed).toHaveLength(0);
    expect(store.listEntries()).toHaveLength(0);
    expect(store.listGroups()).toHaveLength(0);
    expect(store.listTags()).toHaveLength(0);
  });

  it('getSecret/getCodes throw before init (defensive)', () => {
    const s = new AuthenticatorStore(mem, sec as never, auth(false));
    expect(() => s.getSecret('x')).toThrow(/store not initialized/);
    expect(() => s.getCodes(['x'], Date.now())).toThrow(/store not initialized/);
  });

  it('null/empty string groupId normalize to undefined', async () => {
    const r1 = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: null });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.entry.groupId).toBeUndefined();
    const r2 = await store.addEntry({ issuer: 'B', account: 'b', secret: 'JBSWY3DPEHPK3PXP', groupId: '' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.entry.groupId).toBeUndefined();
  });

  it('updateEntry changes secret and updates cache', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const oldSecret = store.getSecret(add.entry.id);
    const newSecretRaw = 'KRSXG5A=';
    const upd = await store.updateEntry(add.entry.id, { secret: newSecretRaw });
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    expect(store.getSecret(add.entry.id)).not.toBe(oldSecret);
  });

  it('addEntry rejects unknown groupId', async () => {
    const r = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: 'nonexistent' });
    expect(r.ok).toBe(false);
  });

  it('addEntry requires issuer or account non-empty', async () => {
    for (const [issuer, account] of [['', ''], ['   ', '  '], ['', undefined]] as const) {
      const r = await store.addEntry({ issuer, account, secret: 'JBSWY3DPEHPK3PXP' });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected invalidField');
      expect(r.reason).toBe('invalidField');
    }
  });

  it('updateEntry allows editing a legacy entry that was already blank', async () => {
    const legacy = {
      id: 'ae-legacy-1', issuer: '', account: '', algorithm: 'SHA1', digits: 6 as const, period: 30 as const,
      tags: [] as string[], createTime: 0, updateTime: 0,
    };
    (mem.map as Map<string, unknown>).set(ENTRIES_KEY, [legacy]);
    store.dispose();
    store = new AuthenticatorStore(mem, sec as never, auth(false));
    await store.init();
    // 移组（只传 groupId）应放行，不被"两者皆空"误伤
    const r = await store.updateEntry('ae-legacy-1', { groupId: null });
    expect(r.ok).toBe(true);
  });

  it('updateEntry rejects clearing both issuer and account', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const upd = await store.updateEntry(add.entry.id, { issuer: '', account: '' });
    expect(upd.ok).toBe(false);
    if (upd.ok) throw new Error('expected invalidField');
    expect(upd.reason).toBe('invalidField');
    // 原值保持不变
    const e = store.listEntries().find((x) => x.id === add.entry.id)!;
    expect(e.issuer).toBe('A');
  });

  it('checkQuota: not logged-in → ok; limit 0 → ok; at cap → false', async () => {
    expect(store.checkQuota()).toEqual({ ok: true });

    store.dispose();
    store = new AuthenticatorStore(mem, sec as never, auth(true, 2));
    await store.init();
    expect(store.checkQuota()).toEqual({ ok: true });
    await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    await store.addEntry({ issuer: 'B', account: 'b', secret: 'JBSWY3DPEHPK3PXP' });
    expect(store.checkQuota()).toEqual({ ok: false, limit: 2 });

    store.dispose();
    store = new AuthenticatorStore(mem, sec as never, auth(true, 0));
    await store.init();
    expect(store.checkQuota()).toEqual({ ok: true });
  });

  it('updateEntry: groupId null/"" → move to ungrouped; omitted → keep group', async () => {
    const g = await store.addGroup('Work');
    if (!g.ok) return;
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.group.id });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const id = add.entry.id;
    // omitted → keep
    await store.updateEntry(id, { issuer: 'X' });
    expect(store.listEntries().find((e) => e.id === id)!.groupId).toBe(g.group.id);
    // null → ungroup
    await store.updateEntry(id, { groupId: null });
    expect(store.listEntries().find((e) => e.id === id)!.groupId).toBeUndefined();
    // back to group, then '' → ungroup
    await store.updateEntry(id, { groupId: g.group.id });
    expect(store.listEntries().find((e) => e.id === id)!.groupId).toBe(g.group.id);
    await store.updateEntry(id, { groupId: '' });
    expect(store.listEntries().find((e) => e.id === id)!.groupId).toBeUndefined();
  });

  // ── exportAll ──
  it('exportAll emits otpauth lines joined by CRLF with trailing CRLF', async () => {
    const a = await store.addEntry({ issuer: 'Acme', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    const b = await store.addEntry({ issuer: 'Beta', account: 'b', secret: 'KRSXG5A' });
    expect(a.ok && b.ok).toBe(true);
    const out = store.exportAll();
    expect(out.endsWith('\r\n')).toBe(true);
    const lines = out.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('otpauth://totp/Acme:a?');
    expect(lines[1]).toContain('otpauth://totp/Beta:b?');
    // no bare LF, no bare CR
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.replace(/\r\n/g, '')).not.toContain('\r');
  });

  it('exportAll skips missing-secret entries; all-missing returns empty string', async () => {
    const a = await store.addEntry({ issuer: 'Acme', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    const b = await store.addEntry({ issuer: 'Beta', account: 'b', secret: 'KRSXG5A' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // externally remove b's secret, then rebuild store so it is flagged missing
    sec.map.delete(`devbelt.authenticator.${b.entry.id}.secret`);
    store.dispose();
    const store2 = new AuthenticatorStore(mem, sec as never, auth(false));
    await store2.init();
    const out = store2.exportAll();
    expect(out).toContain('Acme');
    expect(out).not.toContain('Beta');
    // now remove all and rebuild → ''
    sec.map.delete(`devbelt.authenticator.${a.entry.id}.secret`);
    store2.dispose();
    const store3 = new AuthenticatorStore(mem, sec as never, auth(false));
    await store3.init();
    expect(store3.exportAll()).toBe('');
    store3.dispose();
  });

  // ── addGroup(afterId) / rewriteGroupOrders ──
  it('addGroup afterId inserts between groups (midpoint) with correct order', async () => {
    const g1 = await store.addGroup('A');
    const g2 = await store.addGroup('B');
    if (!g1.ok || !g2.ok) return;
    const mid = await store.addGroup('Mid', g1.group.id);
    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    expect(store.listGroups().map((g) => g.name)).toEqual(['A', 'Mid', 'B']);
    // midpoint between 10 and 20
    expect(mid.group.sortOrder).toBeGreaterThan(g1.group.sortOrder);
    expect(mid.group.sortOrder).toBeLessThan(g2.group.sortOrder);
  });

  it('addGroup afterId with tight gap triggers rewriteGroupOrders and keeps ordering', async () => {
    const g1 = await store.addGroup('A');
    const g2 = await store.addGroup('B');
    if (!g1.ok || !g2.ok) return;
    // force tight sortOrders (difference < 2)
    const groups = store.listGroups() as any[];
    groups.find((g) => g.id === g1.group.id).sortOrder = 10;
    groups.find((g) => g.id === g2.group.id).sortOrder = 11;
    const mid = await store.addGroup('Mid', g1.group.id);
    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    const ordered = store.listGroups();
    expect(ordered.map((g) => g.name)).toEqual(['A', 'Mid', 'B']);
    // tight gap triggers rewriteGroupOrders (10,20) then insert at after+5 → 10,15,20
    expect(ordered.map((g) => g.sortOrder)).toEqual([10, 15, 20]);
  });

  it('addGroup afterId not found falls back to max+10', async () => {
    const g1 = await store.addGroup('A');
    if (!g1.ok) return;
    const g2 = await store.addGroup('B', 'nonexistent');
    expect(g2.ok).toBe(true);
    if (!g2.ok) return;
    expect(g2.group.sortOrder).toBe(20);
  });

  it('addGroupBefore inserts before the anchor, including before the first group', async () => {
    const a = await store.addGroup('A');
    const b = await store.addGroup('B');
    const c = await store.addGroup('C');
    if (!a.ok || !b.ok || !c.ok) return;
    // before B → A, X, B, C
    const x = await store.addGroupBefore('X', b.group.id);
    expect(x.ok).toBe(true);
    if (!x.ok) return;
    expect(store.listGroups().map((g) => g.name)).toEqual(['A', 'X', 'B', 'C']);
    // before first (A) → Y, A, X, B, C
    const y = await store.addGroupBefore('Y', a.group.id);
    expect(y.ok).toBe(true);
    if (!y.ok) return;
    expect(store.listGroups().map((g) => g.name)).toEqual(['Y', 'A', 'X', 'B', 'C']);
  });

  // ── rename/recolor/notFound/invalid ──
  it('renameGroup: invalidName / notFound / success', async () => {
    const g = await store.addGroup('A');
    if (!g.ok) return;
    expect(await store.renameGroup(g.group.id, '   ')).toMatchObject({ ok: false, reason: 'invalidName' });
    expect(await store.renameGroup('nope', 'x')).toMatchObject({ ok: false, reason: 'notFound' });
    expect(await store.renameGroup(g.group.id, ' B ')).toMatchObject({ ok: true });
    expect(store.listGroups().find((x) => x.id === g.group.id)!.name).toBe('B');
  });

  it('renameTag: invalidName / notFound / success', async () => {
    const t = await store.addTag('work', 'blue');
    if (!t.ok) return;
    expect(await store.renameTag(t.tag.id, '')).toMatchObject({ ok: false, reason: 'invalidName' });
    expect(await store.renameTag('nope', 'x')).toMatchObject({ ok: false, reason: 'notFound' });
    expect(await store.renameTag(t.tag.id, 'job')).toMatchObject({ ok: true });
    expect(store.listTags().find((x) => x.id === t.tag.id)!.name).toBe('job');
  });

  it('recolorTag: invalidColor / notFound / success', async () => {
    const t = await store.addTag('work', 'blue');
    if (!t.ok) return;
    expect(await store.recolorTag(t.tag.id, 'hotpink' as any)).toMatchObject({ ok: false, reason: 'invalidColor' });
    expect(await store.recolorTag('nope', 'red')).toMatchObject({ ok: false, reason: 'notFound' });
    expect(await store.recolorTag(t.tag.id, 'red')).toMatchObject({ ok: true });
    expect(store.listTags().find((x) => x.id === t.tag.id)!.color).toBe('red');
  });

  it('addTag rejects empty name with invalidName', async () => {
    expect(await store.addTag('   ', 'blue')).toMatchObject({ ok: false, reason: 'invalidName' });
  });

  it('deleteGroup / deleteTag on unknown id return ok:false', async () => {
    expect(await store.deleteGroup('nope')).toMatchObject({ ok: false });
    expect(await store.deleteTag('nope')).toMatchObject({ ok: false });
    expect(await store.renameGroup('nope', 'x')).toMatchObject({ ok: false, reason: 'notFound' });
  });

  // ── real SecretStorage.delete semantics (missing secret) ──
  it('deleteEntry succeeds even when the secret is already gone (delete resolves)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    sec.map.delete(`devbelt.authenticator.${add.entry.id}.secret`); // simulate external removal
    const del = await store.deleteEntry(add.entry.id);
    expect(del.ok).toBe(true);
    expect(store.listEntries().some((e) => e.id === add.entry.id)).toBe(false);
  });

  it('clearAll succeeds when some secrets are already gone', async () => {
    const a = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    const b = await store.addEntry({ issuer: 'B', account: 'b', secret: 'KRSXG5A' });
    if (!a.ok || !b.ok) return;
    sec.map.delete(`devbelt.authenticator.${a.entry.id}.secret`);
    const res = await store.clearAll();
    expect(res.failed).toHaveLength(0);
    expect(store.listEntries()).toHaveLength(0);
  });

  // ── persistence keys ──
  it('persists entries/groups/tags under the documented globalState keys', async () => {
    const g = await store.addGroup('Work');
    const t = await store.addTag('work', 'blue');
    const e = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.ok ? g.group.id : undefined, tags: t.ok ? [t.tag.id] : [] });
    expect(e.ok).toBe(true);
    expect(mem.map.has('devbelt.authenticator.entries')).toBe(true);
    expect(mem.map.has('devbelt.authenticator.groups')).toBe(true);
    expect(mem.map.has('devbelt.authenticator.tags')).toBe(true);
    const entries = mem.map.get('devbelt.authenticator.entries') as any[];
    expect(entries).toHaveLength(1);
    expect(entries[0].secret).toBeUndefined(); // secret must never be in memento
    // fresh store re-reads all three
    store.dispose();
    const store2 = new AuthenticatorStore(mem, sec as never, auth(false));
    await store2.init();
    expect(store2.listEntries()).toHaveLength(1);
    expect(store2.listGroups()).toHaveLength(1);
    expect(store2.listTags()).toHaveLength(1);
    store2.dispose();
  });

  it('onDidChange does not grow missingSecrets for an id no longer in entries', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const id = add.entry.id;
    await store.deleteEntry(id);
    // simulate the delayed self-write onDidChange after deletion
    sec.emit(`devbelt.authenticator.${id}.secret`);
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.isSecretMissing(id)).toBe(false);
  });

  // ── init canonicalizes whatever SecretStorage holds ──
  it('init normalizes a non-canonical stored secret (lowercase/padding → canonical)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const id = add.entry.id;
    // overwrite with a valid-but-non-canonical form (lowercase); canonical is uppercase
    sec.map.set(`devbelt.authenticator.${id}.secret`, 'jbswy3dpehpk3pxp');
    store.dispose();
    const store2 = new AuthenticatorStore(mem, sec as never, auth(false));
    await store2.init();
    expect(store2.getSecret(id)).toBe('JBSWY3DPEHPK3PXP');
    expect(store2.exportAll()).toContain('secret=JBSWY3DPEHPK3PXP');
    store2.dispose();
  });

  it('init marks a corrupt stored secret as missing (no per-tick throw)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const id = add.entry.id;
    sec.map.set(`devbelt.authenticator.${id}.secret`, '000'); // invalid base32 chars
    store.dispose();
    const store2 = new AuthenticatorStore(mem, sec as never, auth(false));
    await store2.init();
    expect(store2.isSecretMissing(id)).toBe(true);
    expect(store2.getSecret(id)).toBeUndefined();
    expect(store2.getCodes([id], Date.now())[id]).toBeUndefined();
    expect(store2.exportAll()).toBe('');
    store2.dispose();
  });

  // ── onDidChange uses the same normalization as init ──
  it('onDidChange normalizes a non-canonical external value (lowercase → canonical)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const id = add.entry.id;
    sec.map.set(`devbelt.authenticator.${id}.secret`, 'jbswy3dpehpk3pxp');
    sec.emit(`devbelt.authenticator.${id}.secret`);
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getSecret(id)).toBe('JBSWY3DPEHPK3PXP');
    expect(store.exportAll()).toContain('secret=JBSWY3DPEHPK3PXP');
  });

  it('onDidChange marks a corrupt external value as missing (no throw)', async () => {
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const id = add.entry.id;
    sec.map.set(`devbelt.authenticator.${id}.secret`, '===='); // padding-only → empty
    sec.emit(`devbelt.authenticator.${id}.secret`);
    await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.isSecretMissing(id)).toBe(true);
    expect(store.getSecret(id)).toBeUndefined();
    expect(store.getCodes([id], Date.now())[id]).toBeUndefined();
  });

  // ── reorderGroup defensive handling ──
  it('reorderGroup dedupes ids and appends unlisted groups (complete permutation)', async () => {
    const a = await store.addGroup('A');
    const b = await store.addGroup('B');
    const c = await store.addGroup('C');
    if (!a.ok || !b.ok || !c.ok) return;
    // duplicate c, omit b → b appended by its old sortOrder
    await store.reorderGroup([c.group.id, a.group.id, c.group.id]);
    expect(store.listGroups().map((g) => g.name)).toEqual(['C', 'A', 'B']);
    expect(store.listGroups().map((g) => g.sortOrder)).toEqual([10, 20, 30]);
  });

  it('reorderGroup with an incomplete id list keeps all groups, deterministic order', async () => {
    const a = await store.addGroup('A');
    const b = await store.addGroup('B');
    const c = await store.addGroup('C');
    if (!a.ok || !b.ok || !c.ok) return;
    await store.reorderGroup([b.group.id]);
    // listed first, then the rest (A, C) by their previous sortOrder
    expect(store.listGroups().map((g) => g.name)).toEqual(['B', 'A', 'C']);
    expect(store.listGroups().map((g) => g.sortOrder)).toEqual([10, 20, 30]);
  });
});
