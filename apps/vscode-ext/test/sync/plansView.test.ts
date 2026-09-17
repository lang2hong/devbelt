import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en', openExternal: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  ViewColumn: { Active: 1 },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { reveal: vi.fn() };
    post = vi.fn();
    constructor(..._args: unknown[]) { /* noop */ }
    static init(): void { /* noop */ }
    dispose(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/sync/authService', () => ({ DEFAULT_SERVER_URL: 'http://server' }));

import * as vscode from 'vscode';
import { PlansView } from '../../src/sync/plansView';

const CATALOG = {
  personal: [{ code: 'pro', name: 'Pro', billing: { unit: 'month', priceCents: 9900 }, features: [] }],
  organization: [],
};

function makeAuth(overrides: Record<string, unknown> = {}) {
  return {
    isLoggedIn: () => true,
    refreshEntitlement: vi.fn(async () => {}),
    getCachedEntitlement: () => ({ planCode: 'pro' }),
    client: { getPlans: vi.fn(async () => CATALOG) },
    ...overrides,
  } as never;
}

function makeView(auth: unknown): any {
  return new (PlansView as any)(auth);
}

beforeEach(() => {
  vi.mocked(vscode.env.openExternal).mockReset();
});

describe('PlansView', () => {
  it('posts init on first ready, then the catalog with the current plan', async () => {
    const auth = makeAuth();
    const view = makeView(auth);

    await view.handleMessage({ type: 'ready' });
    expect(view.post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'init', mode: 'plans' }));

    await view.handleMessage({ type: 'ready' });
    expect(view.post).toHaveBeenLastCalledWith({ type: 'plans', plans: CATALOG, current: 'pro', loggedIn: true });
  });

  it('reports logged-out without fetching plans', async () => {
    const auth = makeAuth({ isLoggedIn: () => false });
    const view = makeView(auth);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'ready' });
    expect(view.post).toHaveBeenLastCalledWith({ type: 'plans', plans: null, current: null, loggedIn: false });
    expect((auth as any).client.getPlans).not.toHaveBeenCalled();
  });

  it('opens the browser console only for whitelisted paths', async () => {
    const view = makeView(makeAuth());

    await view.handleMessage({ type: 'openConsole', path: '/db/checkout' });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);

    await view.handleMessage({ type: 'openConsole', path: 'https://evil.example/x' });
    await view.handleMessage({ type: 'openConsole', path: '/console/../admin' });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });
});