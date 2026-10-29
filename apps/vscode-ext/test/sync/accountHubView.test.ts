import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en', openExternal: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  ViewColumn: { Active: 1 },
  commands: { executeCommand: vi.fn(async () => {}) },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { reveal: vi.fn() };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    static init(): void { /* noop */ }
    dispose(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/sync/authService', () => ({ DEFAULT_SERVER_URL: 'http://server' }));
vi.mock('../../src/utils/diagnostics', () => ({ diagInfo: vi.fn(), diagWarn: vi.fn(), diagError: vi.fn() }));

import * as vscode from 'vscode';
import { AccountHubView } from '../../src/sync/accountHubView';
import { diagError } from '../../src/utils/diagnostics';

const CATALOG = {
  personal: [{ code: 'pro', name: 'Pro', billing: { unit: 'month', priceCents: 9900 }, features: [] }],
};
const ME = { user: { email: 'a@b.c' }, subscription: null };
const DEVICES = [{ deviceId: 'd1', status: 'active' }];

function makeAuth(overrides: Record<string, unknown> = {}) {
  return {
    isLoggedIn: () => true,
    getMe: vi.fn(async () => ME),
    currentDeviceId: () => 'd1',
    refreshEntitlement: vi.fn(async () => {}),
    getCachedEntitlement: () => ({ planCode: 'pro' }),
    client: {
      getPlans: vi.fn(async () => CATALOG),
      listDevices: vi.fn(async () => ({ devices: DEVICES })),
      revokeDevice: vi.fn(async () => {}),
    },
    ...overrides,
  } as never;
}

function makeFactory(overrides: Record<string, unknown> = {}) {
  return {
    current: undefined,
    ensureSession: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

function makeView(tab: 'account' | 'sync' | 'session' | 'plans' | 'security', auth = makeAuth(), factory = makeFactory()): any {
  return new (AccountHubView as any)(auth, factory, tab);
}

beforeEach(() => {
  vi.mocked(vscode.env.openExternal).mockReset();
  vi.mocked((vscode.commands as any).executeCommand).mockClear();
});

describe('AccountHubView', () => {
  it('first ready posts init{accountHub,tab}; then each view ready fetches its data', async () => {
    const auth = makeAuth();
    const view = makeView('account', auth);

    await view.handleMessage({ type: 'ready' });
    expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'init', mode: 'accountHub', tab: 'account' }));

    await view.handleMessage({ type: 'ready', view: 'account' });
    expect(view.post).toHaveBeenCalledWith({ type: 'me', me: ME });
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'syncStatus' }));

    await view.handleMessage({ type: 'ready', view: 'session' });
    expect(view.post).toHaveBeenLastCalledWith({ type: 'devices', devices: DEVICES, canRevoke: true, currentDeviceId: 'd1' });

    await view.handleMessage({ type: 'ready', view: 'plans' });
    expect(view.post).toHaveBeenLastCalledWith({ type: 'plans', plans: CATALOG, current: 'pro', periodEndTime: null, loggedIn: true });
  });

  it('sync/security ready reuse account + sync status without new endpoints', async () => {
    const auth = makeAuth();
    const view = makeView('sync', auth);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready', view: 'sync' });
    expect(view.post).toHaveBeenCalledWith({ type: 'me', me: ME });
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'syncStatus' }));

    const security = makeView('security', auth);
    await security.handleMessage({ type: 'ready' });
    await security.handleMessage({ type: 'ready', view: 'security' });
    expect(security.post).toHaveBeenCalledWith({ type: 'me', me: ME });
  });

  it('initial tab is delivered in init', async () => {
    const view = makeView('plans');
    await view.handleMessage({ type: 'ready' });
    expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'init', mode: 'accountHub', tab: 'plans' }));
  });

  it('plans reports logged-out without fetching', async () => {
    const auth = makeAuth({ isLoggedIn: () => false });
    const view = makeView('plans', auth);
    await view.handleMessage({ type: 'ready' }); // 首个 ready 触发 init
    await view.handleMessage({ type: 'ready', view: 'plans' });
    expect(view.post).toHaveBeenLastCalledWith({ type: 'plans', plans: null, current: null, loggedIn: false });
    expect((auth as any).client.getPlans).not.toHaveBeenCalled();
  });

  it('whitelisted actions execute; unknown action ignored', async () => {
    const view = makeView('account');
    await view.handleMessage({ type: 'action', action: 'devbelt.syncEntry' });
    await view.handleMessage({ type: 'action', action: 'devbelt.syncNow' });
    await view.handleMessage({ type: 'action', action: 'devbelt.syncPull' });
    expect((vscode.commands as any).executeCommand).toHaveBeenCalledWith('devbelt.syncEntry');
    expect((vscode.commands as any).executeCommand).toHaveBeenCalledWith('devbelt.syncNow');
    expect((vscode.commands as any).executeCommand).toHaveBeenCalledWith('devbelt.syncPull');

    await view.handleMessage({ type: 'action', action: 'workbench.action.terminal' });
    expect((vscode.commands as any).executeCommand).toHaveBeenCalledTimes(3);
  });

  it('revoke revokes the device then refreshes devices', async () => {
    const auth = makeAuth();
    const view = makeView('session', auth);
    await view.handleMessage({ type: 'revoke', deviceId: 'd1' });
    expect((auth as any).client.revokeDevice).toHaveBeenCalledWith('d1');
    expect((auth as any).client.listDevices).toHaveBeenCalledTimes(1);
  });

  it('请求失败：webview 只收到本地化通用文案，原始英文错误进诊断日志', async () => {
    const auth = makeAuth({
      getMe: vi.fn(async () => { throw new Error('Get me failed: 500'); }),
    });
    (auth as any).client.listDevices = vi.fn(async () => { throw new Error('List devices failed: 403'); });
    (auth as any).client.getPlans = vi.fn(async () => { throw new Error('Get plans failed: 500'); });
    (auth as any).client.revokeDevice = vi.fn(async () => { throw new Error('Revoke failed: 500'); });
    const view = makeView('account', auth);
    vi.mocked(diagError).mockClear();

    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready', view: 'account' });
    await view.handleMessage({ type: 'ready', view: 'session' });
    await view.handleMessage({ type: 'ready', view: 'plans' });
    await view.handleMessage({ type: 'revoke', deviceId: 'd1' });

    const errors = view.post.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'error');
    expect(errors).toHaveLength(4);
    for (const m of errors) {
      expect(m.message).toContain('Failed to load');
      expect(m.message).not.toMatch(/failed: \d{3}/);
    }
    const ops = vi.mocked(diagError).mock.calls.map((c) => (c[1] as { op: string }).op);
    expect(ops).toEqual(expect.arrayContaining(['getMe', 'listDevices', 'getPlans', 'revokeDevice']));
    expect(JSON.stringify(vi.mocked(diagError).mock.calls)).toContain('Get me failed: 500');
  });

  it('opens the browser console only for whitelisted paths', async () => {
    const view = makeView('plans');
    await view.handleMessage({ type: 'openConsole', path: '/db/checkout' });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);

    await view.handleMessage({ type: 'openConsole', path: 'https://evil.example/x' });
    await view.handleMessage({ type: 'openConsole', path: '/console/../admin' });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });
});