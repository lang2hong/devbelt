import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  monitorEnabled: true as boolean,
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (k: string, d: unknown) => (section === 'devbelt.ai.monitor' && k === 'enabled' ? h.monitorEnabled : d),
    }),
  },
  env: { language: 'en', clipboard: { writeText: async () => undefined } },
  commands: { executeCommand: async () => undefined },
  window: { showInformationMessage: vi.fn(async () => undefined), showWarningMessage: async () => undefined },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    protected readonly panel = { title: '', webview: { postMessage: h.post, asWebviewUri: (u: unknown) => u }, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }) };
    protected initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    protected post(msg: any): void { h.post(msg); }
    reveal(): void { /* noop */ }
    dispose(): void { (this as any).onDispose?.(); }
    protected onDispose(): void { /* noop */ }
  },
}));

import { AiChatView, monitorToolEnabled } from '../../src/result/aiChatView';
import { MonitorBridge } from '../../src/monitor/monitorBridge';

function deps() {
  const sessions = [
    { id: 's1', title: 'a', messages: [] as any[], createdAt: 0, updatedAt: 0 },
    { id: 's2', title: 'b', messages: [] as any[], createdAt: 0, updatedAt: 0 },
  ];
  return {
    service: { streamChat: vi.fn(), describeProvider: async () => ({ mode: 'server-proxy', model: '', baseUrl: '', available: true }), fetchUsage: async () => null },
    sessions: { create: vi.fn(), get: (id: string) => sessions.find((s) => s.id === id), save: vi.fn(), list: () => sessions, delete: vi.fn(), rename: vi.fn() },
    contextStore: { getDomainContext: () => undefined, getDefaultDirectives: () => undefined, getLastScope: () => undefined } as any,
    keyStore: { getApiKey: async () => undefined, hasApiKey: async () => false } as any,
    manager: { peek: () => undefined, openIsolatedSql: vi.fn() } as any,
    connectionStore: { get: () => undefined, list: () => [] } as any,
    memento: { get: () => undefined, update: async () => undefined } as any,
    auth: { isLoggedIn: () => true },
    executor: {} as any,
    modelAccessStore: { current: () => ({}), getPrefs: () => ({ selection: true, custom: true, key: true }), setPrefs: async () => undefined, saveLocal: async () => undefined } as any,
    providerCatalog: { get: async () => [] } as any,
    ledgerPath: '/tmp/opencode/ledger.jsonl',
  };
}

const proposal = (id: string) => ({ id, kind: 'metric', label: id, connName: 'c', table: 't', intervalMinutes: 5, conditionText: '', warnings: [] });

function proposalPosts(): any[] {
  return h.post.mock.calls.map((c) => c[0]).filter((m) => m?.type === 'monitorProposal');
}

beforeEach(() => {
  h.post.mockClear();
  h.monitorEnabled = true;
  AiChatView.closeAll();
  MonitorBridge.init({
    list: () => [], detail: async () => undefined, action: async () => undefined, resumeAll: async () => undefined,
    confirm: async () => ({ ok: true, task: {} as any }), discard: vi.fn(), executing: () => true,
    onChanged: () => ({ dispose() {} }), describeProposal: () => proposal('x') as any,
  });
});
afterEach(() => MonitorBridge.reset());

describe('monitor proposal cards in AI Chat', () => {
  it('replays a session’s cards (with their status) when the session is loaded again', async () => {
    const view: any = AiChatView.open(deps() as any);
    await view.handleMessage({ type: 'ready' });
    await view.handleMessage({ type: 'loadHistory', sessionId: 's1' });
    view.postProposal(proposal('p1'));
    view.postProposal(proposal('p2'));
    await view.handleMessage({ type: 'monitorDiscard', proposalId: 'p1' });
    await view.handleMessage({ type: 'monitorConfirm', proposalId: 'p2' });

    // 切到另一个会话：不补发 s1 的卡片
    h.post.mockClear();
    await view.handleMessage({ type: 'loadHistory', sessionId: 's2' });
    expect(proposalPosts()).toEqual([]);

    // 切回来：两张卡片都补发，状态保留
    h.post.mockClear();
    await view.handleMessage({ type: 'loadHistory', sessionId: 's1' });
    expect(proposalPosts().map((m) => [m.sessionId, m.proposal.id, m.status])).toEqual([
      ['s1', 'p1', 'discarded'],
      ['s1', 'p2', 'created'],
    ]);
  });

  it('maps a non-owner confirm to reason otherWindow', async () => {
    const view: any = AiChatView.open(deps() as any);
    await view.handleMessage({ type: 'ready' });
    const err = Object.assign(new Error('other window'), { name: 'MonitorNotOwnerError' });
    (MonitorBridge.tryGet()!.handlers as any).confirm = async () => { throw err; };
    h.post.mockClear();
    await view.handleMessage({ type: 'monitorConfirm', proposalId: 'p9' });
    const result = h.post.mock.calls.map((c) => c[0]).find((m) => m?.type === 'monitorConfirmResult');
    expect(result).toMatchObject({ ok: false, reason: 'otherWindow' });
  });
});

describe('propose_monitor registration', () => {
  it('is registered only while monitoring is enabled', () => {
    expect(monitorToolEnabled()).toBe(true);
    h.monitorEnabled = false;
    expect(monitorToolEnabled()).toBe(false);
  });
});
