import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  },
  env: { language: 'en', clipboard: { writeText: async () => undefined } },
  commands: { executeCommand: async () => undefined },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
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

import { agentScopeOf, AiChatView, applyAgentSearchPath } from '../../src/result/aiChatView';

describe('agentScopeOf', () => {
  it('PG: the scope picker selects a database; schema comes from the connection', () => {
    expect(agentScopeOf({ dbType: 'PG', database: 'app', schema: 'sales' } as never, 'reporting')).toEqual({ database: 'reporting', schema: 'sales' });
    expect(agentScopeOf({ dbType: 'PG', database: 'app' } as never, undefined)).toEqual({ database: 'app' });
    expect(agentScopeOf({ dbType: 'PG', database: 'app' } as never, 'app')).toEqual({ database: 'app' });
  });

  it('MySQL / SQLite: scope is the database, never a schema', () => {
    expect(agentScopeOf({ dbType: 'MYSQL', database: 'app', schema: 'x' } as never, 'shop')).toEqual({ database: 'shop' });
    expect(agentScopeOf({ dbType: 'SQLITE' } as never, undefined)).toEqual({});
  });
});

describe('applyAgentSearchPath', () => {
  it('sets the schema first, or resets to the session default', async () => {
    const sql: string[] = [];
    const q = { query: async (s: string) => { sql.push(s); return {}; }, wrap: (s: string) => `"${s}"` };
    await applyAgentSearchPath(q, 'sales');
    await applyAgentSearchPath(q, undefined);
    expect(sql).toEqual(['SET search_path TO "sales", public', 'RESET search_path']);
  });
});

function deps(conn: Record<string, unknown>, onRequest: (req: any) => void) {
  const session = { id: 's1', title: 't', messages: [] as any[], createdAt: 0, updatedAt: 0 };
  const executed: string[] = [];
  const query = { query: vi.fn(async (s: string) => { executed.push(s); return { rows: [] }; }), wrap: (s: string) => `"${s}"` };
  const openIsolatedSql = vi.fn(async () => ({ session: { query, metadata: {}, kind: 'sql' }, close: vi.fn() }));
  return {
    executed,
    openIsolatedSql,
    deps: {
      service: {
        streamChat: (req: any) => {
          onRequest(req);
          return { abort() { /* noop */ }, async *[Symbol.asyncIterator]() { yield { delta: 'ok' }; } };
        },
        describeProvider: async () => ({ mode: 'server-proxy', model: '', baseUrl: '', available: true }),
        fetchUsage: async () => null,
      },
      sessions: { get: () => session, create: () => session, save: vi.fn(), list: () => [session], delete: vi.fn(), rename: vi.fn() },
      contextStore: { getLastScope: () => undefined, getDomainContext: () => undefined, getDefaultDirectives: () => undefined } as any,
      keyStore: { getApiKey: async () => undefined, hasApiKey: async () => false } as any,
      manager: { peek: () => undefined, openIsolatedSql } as any,
      connectionStore: { get: () => conn, list: () => [conn] } as any,
      memento: { get: () => undefined, update: async () => undefined } as any,
      auth: { isLoggedIn: () => true },
      executor: {} as any,
      modelAccessStore: { current: () => ({}), getPrefs: () => ({ selection: true, custom: true, key: true }), setPrefs: async () => undefined, saveLocal: async () => undefined } as any,
      providerCatalog: { get: async () => [] } as any,
      ledgerPath: '/tmp/opencode/ledger.jsonl',
    },
    session,
  };
}

beforeEach(() => {
  h.post.mockClear();
  AiChatView.closeAll();
});

describe('runAgent on PostgreSQL', () => {
  it('opens the selected database and keeps the connection schema', async () => {
    const conn = { id: 'c1', name: 'pg', host: 'h', dbType: 'PG', database: 'app', schema: 'sales' };
    const d = deps(conn, () => undefined);
    const view: any = AiChatView.open(d.deps as any);
    view.selectedScope = 'reporting';
    await view.runAgent(d.session, [{ role: 'user', content: 'hi' }], conn);
    expect(d.openIsolatedSql).toHaveBeenCalledWith(conn, 'reporting');
    expect(d.executed).toContain('SET search_path TO "sales", public');
    expect(d.executed).not.toContain('SET search_path TO "reporting", public');
  });

  it('resets search_path when the connection has no schema', async () => {
    const conn = { id: 'c1', name: 'pg', host: 'h', dbType: 'PG', database: 'app' };
    const d = deps(conn, () => undefined);
    const view: any = AiChatView.open(d.deps as any);
    await view.runAgent(d.session, [{ role: 'user', content: 'hi' }], conn);
    expect(d.openIsolatedSql).toHaveBeenCalledWith(conn, 'app');
    expect(d.executed).toContain('RESET search_path');
  });
});
