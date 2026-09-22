import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AuthenticatorStore } from '../../src/authenticator/store.js';
import { encodeBase32UpperCaseNoPadding } from '../../src/authenticator/base32.js';

/** In-memory Memento stub (Map-backed, same shape as vscode.Memento). */
function memento() {
  const store = new Map<string, unknown>();
  return {
    keys: () => Array.from(store.keys()),
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    update: async (k: string, v: unknown) => { store.set(k, v); },
  };
}

/** In-memory SecretStorage stub with onDidChange emitter. */
function secretsWithEvents() {
  const map = new Map<string, string>();
  const listeners: Array<(e: { key: string }) => void> = [];
  return {
    map,
    emit: (key: string) => listeners.forEach((l) => l({ key })),
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) {
      const had = map.has(k);
      map.delete(k);
      if (!had) throw new Error('secret not found');
    },
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

  it('deleteGroup sets entries groupId to undefined (no orphan default group)', async () => {
    const g = await store.addGroup('Work');
    expect('error' in g ? false : true).toBe(true);
    if ('error' in g) return;
    const add = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', groupId: g.id });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect((store.listEntries().find((e) => e.id === add.entry.id)!).groupId).toBe(g.id);
    const dg = await store.deleteGroup(g.id);
    expect(dg.ok).toBe(true);
    expect((store.listEntries().find((e) => e.id === add.entry.id)!).groupId).toBeUndefined();
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
    expect('error' in g1 ? false : g1.sortOrder).toBe(10);
    expect('error' in g2 ? false : g2.sortOrder).toBe(20);
    if ('error' in g1 || 'error' in g2) return;
    await store.reorderGroup([g2.id, g1.id]);
    const ordered = store.listGroups();
    expect(ordered.map((g) => g.id)).toEqual([g2.id, g1.id]);
    expect(ordered[0].sortOrder).toBe(10);
    expect(ordered[1].sortOrder).toBe(20);
  });

  it('addTag rejects non-whitelist colors', async () => {
    const r = await store.addTag('x', 'hotpink' as any);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected invalidColor');
    expect(r.reason).toBe('invalidColor');
  });

  it('clearAll fault tolerance: a single failing secret delete keeps others and leaves index intact', async () => {
    const r1 = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    const r2 = await store.addEntry({ issuer: 'B', account: 'b', secret: 'JBSWY3DPEHPK3PXP' });
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
    expect(store.listGroups()).toHaveLength(0);
    expect(store.listTags()).toHaveLength(0);
  });

  it('clearAll: no orphans — memento entries only removed after secret delete succeeds', async () => {
    // Already covered by above case; add a no-failure path for completeness
    const r = await store.addEntry({ issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await store.clearAll();
    expect(res.failed).toHaveLength(0);
    expect(store.listEntries()).toHaveLength(0);
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
});
