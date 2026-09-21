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

import * as vscode from 'vscode';
import { AccountHubView } from '../../src/sync/accountHubView';

const CATALOG = {
  personal: [{ code: 'pro', name: 'Pro', billing: { unit: 'month', priceCents: 9900 }, features: [] }],
  organization: [],
};
const ME = { user: { email: 'a@b.c' }, subscription: null };
const DEVICES = [{ deviceId: 'd1', status: 'active' }];

function makeAuth(overrides: Record<string, unknown> = {}) {
  return {
    isLoggedIn: () => true,
    getMe: vi.fn(async () => ME),
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

function makeView(tab: 'account' | 'session' | 'plans', auth = makeAuth(), factory = makeFactory()): any {
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
    expect(view.post).toHaveBeenLastCalledWith({ type: 'devices', devices: DEVICES, canRevoke: true });

    await view.handleMessage({ type: 'ready', view: 'plans' });
    expect(view.post).toHaveBeenLastCalledWith({ type: 'plans', plans: CATALOG, current: 'pro', loggedIn: true });
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

  it('whitelisted action executes the command; unknown action ignored', async () => {
    const view = makeView('account');
    await view.handleMessage({ type: 'action', action: 'devbelt.syncPull' });
    expect((vscode.commands as any).executeCommand).toHaveBeenCalledWith('devbelt.syncPull');

    await view.handleMessage({ type: 'action', action: 'workbench.action.terminal' });
    expect((vscode.commands as any).executeCommand).toHaveBeenCalledTimes(1);
  });

  it('revoke revokes the device then refreshes devices', async () => {
    const auth = makeAuth();
    const view = makeView('session', auth);
    await view.handleMessage({ type: 'revoke', deviceId: 'd1' });
    expect((auth as any).client.revokeDevice).toHaveBeenCalledWith('d1');
    expect((auth as any).client.listDevices).toHaveBeenCalledTimes(1);
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