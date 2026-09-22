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

import * as vscode from 'vscode';
import { AuthenticatorViewProvider } from '../../src/authenticator/authenticatorViewProvider';
import type { AuthenticatorStore } from '../../src/authenticator/store';

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
}) {
  const entries = overrides?.entries ?? [
    { id: 'e1', issuer: 'Acme', account: 'a', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 0, updateTime: 0, groupId: undefined },
  ];
  const missing = overrides?.missing ?? new Set<string>();
  let lastIds: string[] = [];
  const posted: any[] = [];
  let handleMsg: ((m: any) => void) | undefined;
  let visibility: (() => void) | undefined;
  let disposeView: (() => void) | undefined;

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
  } as unknown as AuthenticatorStore;

  const view: FakeView = {
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

  const provider = new AuthenticatorViewProvider({ toString: () => 'uri' } as any, store);
  provider.resolveWebviewView(view as any);

  return {
    provider, view, posted,
    send: (m: any) => handleMsg?.(m),
    setVisible: (v: boolean) => { view.visible = v; visibility?.(); },
    disposeView: () => disposeView?.(),
    getLastIds: () => lastIds,
  };
}

describe('AuthenticatorViewProvider', () => {
  beforeEach(() => {
    (vscode.env.clipboard.writeText as any).mockClear();
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
    // make listEntries throw on snapshot
    (h.provider as any).store.listEntries = () => { throw new Error('boom'); };
    h.send({ type: 'ready', __load: 'L1' });
    await flush();
    h.send({ type: 'ready', __load: 'L1' });
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
});