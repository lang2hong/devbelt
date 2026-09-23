import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const holder = vi.hoisted(() => ({ latestPanel: undefined as any }));

vi.mock('vscode', () => ({
  env: { language: 'en', clipboard: { writeText: vi.fn(async () => { /* noop */ }) } },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  Uri: { file: (s: string) => ({ toString: () => s }), parse: (s: string) => ({ toString: () => s }), joinPath: () => ({ toString: () => 'uri' }) },
  ViewColumn: { Active: 1 },
  window: { createWebviewPanel: () => holder.latestPanel },
}));
vi.mock('../../src/webview/html', () => ({ getWebviewHtml: () => '<html></html>' }));
vi.mock('../../src/i18n', () => ({ isZh: () => false, l10n: (k: string) => `msg:${k}` }));
vi.mock('../../src/utils/diagnostics', () => ({ diagError: vi.fn(), diagWarn: vi.fn(), diagInfo: vi.fn() }));
vi.mock('../../src/authenticator/quotaPrompt', () => ({ promptAuthenticatorUpgrade: vi.fn(async () => { /* noop */ }) }));
vi.mock('../../src/authenticator/exportAll', () => ({ exportAuthenticatorEntries: vi.fn(async () => { /* noop */ }) }));
vi.mock('../../src/authenticator/qrDecode', () => ({
  decodeOtpauthFromPngDataUrl: vi.fn(() => 'otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30'),
}));

import * as vscode from 'vscode';
import { BaseWebView } from '../../src/result/baseWebView';
import { AuthenticatorView } from '../../src/authenticator/authenticatorView';
import type { AuthenticatorStore } from '../../src/authenticator/store';
import { promptAuthenticatorUpgrade } from '../../src/authenticator/quotaPrompt';
import { exportAuthenticatorEntries } from '../../src/authenticator/exportAll';
import { decodeOtpauthFromPngDataUrl } from '../../src/authenticator/qrDecode';

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }

interface PanelMock {
  posted: any[];
  send: (m: any) => void;
  fireDispose: () => void;
  reveal: ReturnType<typeof vi.fn>;
}

function makePanel(): PanelMock {
  const posted: any[] = [];
  let msgHandler: ((m: any) => void) | undefined;
  let disposeHandler: (() => void) | undefined;
  const panel = {
    webview: {
      html: '', cspSource: '', asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (h: (m: any) => void) => { msgHandler = h; return { dispose() { /* noop */ } }; },
      postMessage: async (m: any) => { posted.push(m); return true; },
    },
    onDidDispose: (h: () => void) => { disposeHandler = h; return { dispose() { /* noop */ } }; },
    reveal: vi.fn(),
    // 真实 VS Code 中 panel.dispose() 会触发 onDidDispose；mock 需对齐，否则单例残留。
    dispose: vi.fn(() => { disposeHandler?.(); }),
  };
  holder.latestPanel = panel;
  return { posted, send: (m) => msgHandler?.(m), fireDispose: () => disposeHandler?.(), reveal: panel.reveal };
}

function makeStore(overrides?: Record<string, any>): AuthenticatorStore {
  const entries = overrides?.entries ?? [
    { id: 'e1', issuer: 'Acme', account: 'a', algorithm: 'SHA1', digits: 6, period: 30, tags: [], createTime: 0, updateTime: 0, groupId: undefined },
  ];
  return {
    listEntries: () => entries,
    listGroups: () => [],
    listTags: () => [],
    isSecretMissing: () => false,
    getCodes: (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, { code: '123456', secondsLeft: 10 }])),
    addEntry: vi.fn(async () => ({ ok: true, entry: { id: 'new' } })),
    updateEntry: vi.fn(async () => ({ ok: true })),
    deleteEntry: vi.fn(async () => ({ ok: true })),
    addGroup: vi.fn(async () => ({ ok: true, group: { id: 'g', name: 'x', sortOrder: 10 } })),
    addGroupBefore: vi.fn(async () => ({ ok: true, group: { id: 'g', name: 'x', sortOrder: 5 } })),
    renameGroup: vi.fn(async () => ({ ok: true })),
    deleteGroup: vi.fn(async () => ({ ok: true })),
    reorderGroup: vi.fn(async () => { /* noop */ }),
    addTag: vi.fn(async () => ({ ok: true, tag: { id: 't', name: 'x', color: 'blue' } })),
    deleteTag: vi.fn(async () => ({ ok: true })),
    checkQuota: vi.fn(() => ({ ok: true })),
    ...overrides,
  } as unknown as AuthenticatorStore;
}

describe('AuthenticatorView (panel)', () => {
  beforeEach(() => {
    BaseWebView.init({ toString: () => 'uri' } as any);
    (vscode.env.clipboard.writeText as any).mockClear();
    (promptAuthenticatorUpgrade as any).mockClear();
    (exportAuthenticatorEntries as any).mockClear();
    (decodeOtpauthFromPngDataUrl as any).mockClear();
  });
  afterEach(() => {
    AuthenticatorView.disposeCurrent();
    holder.latestPanel?.dispose?.();
  });

  it('two-phase handshake: 1st ready → init; 2nd ready → snapshot + tick', async () => {
    const p = makePanel();
    AuthenticatorView.open(makeStore());
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    expect(p.posted.filter((m) => m.type === 'init')).toHaveLength(1);
    expect(p.posted.find((m) => m.type === 'init')).toMatchObject({ mode: 'authenticator' });
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    expect(p.posted.some((m) => m.type === 'snapshot')).toBe(true);
    expect(p.posted.some((m) => m.type === 'tick')).toBe(true);
  });

  it('open twice reveals the existing panel instead of creating a new one', () => {
    const p = makePanel();
    AuthenticatorView.open(makeStore());
    AuthenticatorView.open(makeStore());
    expect(vscode.window.createWebviewPanel).toBeDefined();
    expect(p.reveal).toHaveBeenCalled();
  });

  it('add normalizes groupId null → undefined; invalid → formError', async () => {
    const p = makePanel();
    const store = makeStore();
    AuthenticatorView.open(store);
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    p.send({ type: 'add', entry: { issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, groupId: null, tags: [] } });
    await flush();
    expect(store.addEntry).toHaveBeenCalledWith(expect.objectContaining({ groupId: undefined }));

    (store.addEntry as any).mockResolvedValueOnce({ ok: false, reason: 'invalidField', field: 'issuer' });
    p.send({ type: 'add', entry: { issuer: '', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, groupId: null, tags: [] } });
    await flush();
    expect(p.posted.some((m) => m.type === 'formError' && /invalidField/.test(m.message))).toBe(true);
  });

  it('copy validates code; valid → clipboard + copyOk', async () => {
    const p = makePanel();
    AuthenticatorView.open(makeStore());
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    p.send({ type: 'copy', code: 'abc', entryId: 'e1' });
    await flush();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
    p.send({ type: 'copy', code: '123456', entryId: 'e1' });
    await flush();
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('123456');
    expect(p.posted.some((m) => m.type === 'copyOk' && m.entryId === 'e1')).toBe(true);
  });

  it('requestAddForm at cap → upgrade prompt, no openAddForm', async () => {
    const p = makePanel();
    AuthenticatorView.open(makeStore({ checkQuota: vi.fn(() => ({ ok: false, limit: 5 })) }));
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    p.send({ type: 'requestAddForm' });
    await flush();
    expect(promptAuthenticatorUpgrade).toHaveBeenCalledWith(5);
    expect(p.posted.some((m) => m.type === 'openAddForm')).toBe(false);
  });

  it('addImage: migration decoded → unsupported message', async () => {
    (decodeOtpauthFromPngDataUrl as any).mockReturnValueOnce('otpauth-migration://offline?data=AAAA');
    const p = makePanel();
    AuthenticatorView.open(makeStore());
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    p.send({ type: 'addImage', dataUrl: 'data:image/png;base64,AAAA' });
    await flush();
    expect(p.posted.some((m) => m.type === 'formError' && /migrationUnsupported/.test(m.message))).toBe(true);
  });

  it('export forwards to exportAuthenticatorEntries', async () => {
    const p = makePanel();
    const store = makeStore();
    AuthenticatorView.open(store);
    p.send({ type: 'ready', __load: 'L1' });
    await flush();
    p.send({ type: 'export' });
    await flush();
    expect(exportAuthenticatorEntries).toHaveBeenCalledWith(store);
  });

  it('dispose clears the singleton so a later open creates a fresh panel', async () => {
    const p1 = makePanel();
    AuthenticatorView.open(makeStore());
    p1.fireDispose();
    await flush();
    const p2 = makePanel();
    AuthenticatorView.open(makeStore());
    expect(p2.posted).toBeDefined();
    // 新面板握手可用
    p2.send({ type: 'ready', __load: 'L2' });
    await flush();
    expect(p2.posted.filter((m) => m.type === 'init')).toHaveLength(1);
  });
});
