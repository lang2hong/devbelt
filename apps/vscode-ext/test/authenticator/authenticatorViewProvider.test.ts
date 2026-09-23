import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  env: { clipboard: { writeText: vi.fn(async () => { /* noop */ }) } },
}));
vi.mock('../../src/webview/html', () => ({ getWebviewHtml: () => '<html></html>' }));
vi.mock('../../src/i18n', () => ({
  isZh: () => false,
  l10n: (k: string) => `msg:${k}`,
}));
vi.mock('../../src/utils/diagnostics', () => ({
  diagError: vi.fn(), diagWarn: vi.fn(), diagInfo: vi.fn(),
}));
vi.mock('../../src/authenticator/quotaPrompt', () => ({
  promptAuthenticatorUpgrade: vi.fn(async () => { /* noop */ }),
}));
vi.mock('../../src/authenticator/exportAll', () => ({
  exportAuthenticatorEntries: vi.fn(async () => { /* noop */ }),
}));

import * as vscode from 'vscode';
import { AuthenticatorViewProvider } from '../../src/authenticator/authenticatorViewProvider';
import type { AuthenticatorStore } from '../../src/authenticator/store';
import { promptAuthenticatorUpgrade } from '../../src/authenticator/quotaPrompt';
import { exportAuthenticatorEntries } from '../../src/authenticator/exportAll';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface FakeView {
  visible: boolean;
  webview: { options: any; html: string; onDidReceiveMessage: (h: (m: any) => void) => { dispose(): void }; postMessage: (m: any) => Promise<boolean> };
  onDidChangeVisibility: (h: () => void) => { dispose(): void };
  onDidDispose: (h: () => void) => { dispose(): void };
}

function makeHarness(overrides?: {
  entries?: any[];
  missing?: Set<string>;
  getCodes?: (ids: readonly string[], now: number) => Record<string, { code: string; secondsLeft: number }>;
  store?: Record<string, any>;
}) {
  const entries = overrides?.entries ?? [
    { id: 'e1', issuer: 'Acme', account: 'a', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 0, updateTime: 0, groupId: undefined },
  ];
  const missing = overrides?.missing ?? new Set<string>();
  let lastIds: string[] = [];
  let posted: any[] = [];
  let handleMsg: ((m: any) => void) | undefined;
  let visibility: (() => void) | undefined;
  let disposeView: (() => void) | undefined;

  const mutationFns = {
    addEntry: vi.fn(async () => ({ ok: true, entry: { id: 'new' } })),
    updateEntry: vi.fn(async () => ({ ok: true, entry: { id: 'e1' } })),
    deleteEntry: vi.fn(async () => ({ ok: true })),
    addGroup: vi.fn(async () => ({ ok: true, group: { id: 'g', name: 'x', sortOrder: 10 } })),
    addGroupBefore: vi.fn(async () => ({ ok: true, group: { id: 'g', name: 'x', sortOrder: 5 } })),
    renameGroup: vi.fn(async () => ({ ok: true })),
    deleteGroup: vi.fn(async () => ({ ok: true })),
    reorderGroup: vi.fn(async () => { /* noop */ }),
    addTag: vi.fn(async () => ({ ok: true, tag: { id: 't', name: 'x', color: 'blue' } })),
    deleteTag: vi.fn(async () => ({ ok: true })),
    checkQuota: vi.fn(() => ({ ok: true })),
  };

  const store = {
    listEntries: () => entries,
    listGroups: () => [],
    listTags: () => [],
    isSecretMissing: (id: string) => missing.has(id),
    getCodes: (ids: readonly string[], now: number) => {
      lastIds = [...ids];
      if (overrides?.getCodes) return overrides.getCodes(ids, now);
      const out: Record<string, { code: string; secondsLeft: number }> = {};
      for (const id of ids) out[id] = { code: '123456', secondsLeft: 10 };
      return out;
    },
    ...mutationFns,
    ...(overrides?.store ?? {}),
  } as unknown as AuthenticatorStore;

  function newView(): FakeView {
    return {
      visible: true,
      webview: {
        options: {},
        html: '',
        onDidReceiveMessage: (h) => { handleMsg = h; return { dispose() { /* noop */ } }; },
        postMessage: async (m) => { posted.push(m); return true; },
      },
      onDidChangeVisibility: (h) => { visibility = h; return { dispose() { /* noop */ } }; },
      onDidDispose: (h) => { disposeView = h; return { dispose() { /* noop */ } }; },
    };
  }

  const provider = new AuthenticatorViewProvider({ toString: () => 'uri' } as any, store);
  let view = newView();
  provider.resolveWebviewView(view as any);

  const api = {
    provider,
    store: store as any,
    get view() { return view; },
    get posted() { return posted; },
    getLastIds: () => lastIds,
    send: (m: any) => handleMsg?.(m),
    setVisible: (v: boolean) => { view.visible = v; visibility?.(); },
    disposeView: () => disposeView?.(),
    reResolve: () => { posted = []; view = newView(); provider.resolveWebviewView(view as any); return api; },
  };
  return api;
}

describe('AuthenticatorViewProvider', () => {
  beforeEach(() => {
    (vscode.env.clipboard.writeText as any).mockClear();
    (promptAuthenticatorUpgrade as any).mockClear();
    (exportAuthenticatorEntries as any).mockClear();
  });

  it('two-phase handshake: 1st ready → init; 2nd ready → snapshot + tick', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    expect(h.posted.filter((m) => m.type === 'init')).toHaveLength(1);
    expect(h.posted.find((m) => m.type === 'init')).toMatchObject({ mode: 'authenticator', isZh: false });
    expect(h.posted.some((m) => m.type === 'snapshot')).toBe(false);

    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    expect(h.posted.filter((m) => m.type === 'snapshot')).toHaveLength(1);
    const tick = h.posted.find((m) => m.type === 'tick');
    expect(tick).toBeDefined();
    expect(tick.codes.e1).toEqual({ code: '123456', secondsLeft: 10 });
  });

  it('new __load resets handshake (re-init)', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' }); // 2nd ready
    await flush();
    expect(h.posted.filter((m) => m.type === 'init')).toHaveLength(1);

    // 视图重载：新 load id，握手从头再来
    h.send({ type: 'ready', __load: 'L2' });
    await flush();
    expect(h.posted.filter((m) => m.type === 'init')).toHaveLength(2);
  });

  it('snapshot uses groupId null for ungrouped and flags secretMissing', async () => {
    const h = makeHarness({ missing: new Set(['e1']) });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    const snap = h.posted.find((m) => m.type === 'snapshot');
    expect(snap.entries[0].groupId).toBeNull();
    expect(snap.entries[0].error).toBe('secretMissing');
    expect(snap.entries[0].secret).toBeUndefined();
  });

  it('folded group entries are excluded from tick', async () => {
    const entries = [
      { id: 'e1', issuer: 'A', account: 'a', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 0, updateTime: 0, groupId: undefined },
      { id: 'e2', issuer: 'B', account: 'b', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 0, updateTime: 0, groupId: 'g1' },
    ];
    const h = makeHarness({ entries });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    // fold ungrouped (null)
    h.send({ type: 'toggleGroup', groupId: null, folded: true });
    await flush();
    // 折叠不即时补发，下一次 tick（可见性驱动）应排除该组
    h.setVisible(false);
    h.setVisible(true);
    await flush();
    expect(h.getLastIds()).toEqual(['e2']);
    // expand ungrouped → 立即补发，both
    h.send({ type: 'toggleGroup', groupId: null, folded: false });
    await flush();
    expect(h.getLastIds().sort()).toEqual(['e1', 'e2']);
  });

  it('copy validates code format; valid code writes clipboard + copyOk', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();

    h.send({ type: 'copy', code: 'abc', entryId: 'e1' });
    await flush();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    expect(h.posted.some((m) => m.type === 'formError')).toBe(true);

    h.send({ type: 'copy', code: '123456', entryId: 'e1' });
    await flush();
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('123456');
    expect(h.posted.some((m) => m.type === 'copyOk' && m.entryId === 'e1')).toBe(true);
  });

  it('openAddForm before ready is queued and replayed after 2nd ready', async () => {
    const h = makeHarness();
    h.provider.openAddForm();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    expect(h.posted.some((m) => m.type === 'openAddForm')).toBe(false);
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    expect(h.posted.some((m) => m.type === 'openAddForm')).toBe(true);
  });

  it('handleMessage error boundary posts a generic error', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    // 让一个 handler 直接抛错，验证 handleMessage 外层边界回发通用 error
    (h.provider as any).onCopy = () => { throw new Error('boom'); };
    h.send({ type: 'copy', code: '123456', entryId: 'e1' });
    await flush();
    expect(h.posted.some((m) => m.type === 'error')).toBe(true);
  });

  it('post guard: after view dispose, refresh() does not throw', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.disposeView();
    await expect(h.provider.refresh()).resolves.toBeUndefined();
    expect(() => h.provider.openAddForm()).not.toThrow();
  });

  it('getCodes throw is swallowed; refresh() resolves (store-not-ready safety)', async () => {
    const h = makeHarness({ getCodes: () => { throw new Error('store not initialized'); } });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    // tick 内部抛错被吞：不发 tick，也不冒泡到事件回调
    expect(h.posted.some((m) => m.type === 'tick')).toBe(false);
    expect(() => { h.setVisible(false); h.setVisible(true); }).not.toThrow();
    await expect(h.provider.refresh()).resolves.toBeUndefined();
  });

  it('re-resolve resets folded state', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'toggleGroup', groupId: null, folded: true });
    h.setVisible(false);
    h.setVisible(true);
    await flush();
    expect(h.getLastIds()).toEqual([]); // 未分组已折叠，排除 e1

    h.reResolve();
    h.send({ type: 'ready', __load: 'L2' });
    await flush();
    h.send({ type: 'ready', __load: 'L2' });
    await flush();
    expect(h.getLastIds()).toEqual(['e1']); // 折叠态随重载复位
  });

  it('refresh() posts both snapshot and tick', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.posted.length = 0;
    await h.provider.refresh();
    expect(h.posted.some((m) => m.type === 'snapshot')).toBe(true);
    expect(h.posted.some((m) => m.type === 'tick')).toBe(true);
  });

  it('toggleGroup ignores non-boolean folded', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'toggleGroup', groupId: null, folded: 'yes' });
    h.setVisible(false);
    h.setVisible(true);
    await flush();
    expect(h.getLastIds()).toEqual(['e1']); // 非法值不改变折叠态
  });

  // ── S3 actions ──
  it('add normalizes groupId null → undefined and calls store.addEntry', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'add', entry: { issuer: 'A', account: 'a', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, groupId: null, tags: [] } });
    await flush();
    expect(h.store.addEntry).toHaveBeenCalledWith(expect.objectContaining({ issuer: 'A', groupId: undefined }));
  });

  it('add invalidSecret → formError on secret field', async () => {
    const h = makeHarness({ store: { addEntry: vi.fn(async () => ({ ok: false, reason: 'invalidSecret', field: 'secret' })) } });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'add', entry: { issuer: 'A', secret: '000', algorithm: 'SHA1', digits: 6, period: 30, groupId: null, tags: [] } });
    await flush();
    const fe = h.posted.find((m) => m.type === 'formError');
    expect(fe).toMatchObject({ field: 'secret' });
  });

  it('add quota → upgrade prompt (no formError)', async () => {
    const h = makeHarness({ store: { addEntry: vi.fn(async () => ({ ok: false, reason: 'quota', limit: 10 })) } });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'add', entry: { issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, groupId: null, tags: [] } });
    await flush();
    expect(promptAuthenticatorUpgrade).toHaveBeenCalledWith(10);
    expect(h.posted.some((m) => m.type === 'formError')).toBe(false);
  });

  it('update passes groupId undefined when omitted, null when explicitly ungrouped', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'update', id: 'e1', patch: { issuer: 'X' } });
    await flush();
    expect(h.store.updateEntry).toHaveBeenLastCalledWith('e1', expect.objectContaining({ groupId: undefined }));
    // explicit null → 原样交给 store（store 语义：null = 移到未分组）
    (h.store.updateEntry as any).mockClear();
    h.send({ type: 'update', id: 'e1', patch: { groupId: null } });
    await flush();
    expect(h.store.updateEntry).toHaveBeenLastCalledWith('e1', expect.objectContaining({ groupId: null }));
  });

  it('delete calls store.deleteEntry', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'delete', id: 'e1' });
    await flush();
    expect(h.store.deleteEntry).toHaveBeenCalledWith('e1');
  });

  it('addGroup invalidName → formError; addTag invalidColor → formError', async () => {
    const h = makeHarness({ store: {
      addGroup: vi.fn(async () => ({ ok: false, reason: 'invalidName' })),
      addTag: vi.fn(async () => ({ ok: false, reason: 'invalidColor' })),
    } });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'addGroup', name: '   ' });
    await flush();
    h.send({ type: 'addTag', name: 'x', color: 'blue' });
    await flush();
    expect(h.posted.filter((m) => m.type === 'formError')).toHaveLength(2);
  });

  it('requestAddForm at cap → upgrade prompt, no openAddForm', async () => {
    const h = makeHarness({ store: { checkQuota: vi.fn(() => ({ ok: false, limit: 5 })) } });
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'requestAddForm' });
    await flush();
    expect(promptAuthenticatorUpgrade).toHaveBeenCalledWith(5);
    expect(h.posted.some((m) => m.type === 'openAddForm')).toBe(false);
  });

  it('requestAddForm under cap → openAddForm', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'requestAddForm' });
    await flush();
    expect(h.posted.some((m) => m.type === 'openAddForm')).toBe(true);
  });

  it('addGroup beforeId → addGroupBefore; afterId → addGroup; none → addGroup(undefined)', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'addGroup', name: 'X', beforeId: 'g1' });
    await flush();
    expect(h.store.addGroupBefore).toHaveBeenCalledWith('X', 'g1');
    (h.store.addGroupBefore as any).mockClear();
    h.send({ type: 'addGroup', name: 'Y', afterId: 'g1' });
    await flush();
    expect(h.store.addGroup).toHaveBeenCalledWith('Y', 'g1');
    expect(h.store.addGroupBefore).not.toHaveBeenCalled();
    (h.store.addGroup as any).mockClear();
    h.send({ type: 'addGroup', name: 'Z' });
    await flush();
    expect(h.store.addGroup).toHaveBeenCalledWith('Z', undefined);
  });

  it('export message calls exportAuthenticatorEntries', async () => {
    const h = makeHarness();
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'export' });
    await flush();
    expect(exportAuthenticatorEntries).toHaveBeenCalledWith(h.store);
  });
});
