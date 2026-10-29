import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1 },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
  window: { showWarningMessage: h.warn },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { title: '' };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    dispose(): void { this.onDispose(); }
    reveal(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

import { SlowQueryPanel, normalizeFilter } from '../../src/insights/slowQueryPanel';
import { HistoryStore, type QueryHistoryEntry } from '../../src/history/historyStore';

function memento(initial: QueryHistoryEntry[] = []) {
  let data = initial;
  return {
    get: <T>(): T | undefined => data as T,
    update: async (_k: string, value: any) => { data = value; },
  };
}

function setup(entries: QueryHistoryEntry[] = []) {
  const history = new HistoryStore(memento(entries));
  const conns = [{ id: 'c1', name: 'local', host: 'localhost' }] as any[];
  const openSql = vi.fn(async () => undefined);
  const explain = vi.fn();
  const view: any = SlowQueryPanel.open({
    history,
    connections: () => conns,
    historyLimit: () => 100,
    scanOptionsFor: () => ({}),
    openSql,
    explain,
  });
  return { view, history, openSql, explain };
}

function posts(view: any): any[] {
  return view.post.mock.calls.map((c: any[]) => c[0]);
}

function lastSnapshot(view: any): any {
  return posts(view).filter((m) => m.type === 'slowSnapshot').at(-1);
}

async function mount(view: any): Promise<void> {
  await view.handleMessage({ type: 'ready' });
  await view.handleMessage({ type: 'ready' });
}

const now = Date.now();
const rows: QueryHistoryEntry[] = [
  { id: '1', sql: 'SELECT * FROM users WHERE id = 1', connection: 'local', connectionId: 'c1', database: 'app', time: now - 1000, costTime: 300 },
  { id: '2', sql: 'SELECT * FROM users WHERE id = 2', connection: 'local', connectionId: 'c1', database: 'app', time: now - 60_000, costTime: 100 },
  { id: '3', sql: 'SELECT * FROM gone', connection: 'old', connectionId: 'deleted', time: now - 2000, costTime: 50 },
];

beforeEach(() => {
  SlowQueryPanel.closeAll();
  h.warn.mockClear();
});

describe('SlowQueryPanel', () => {
  it('two-ready protocol: init first, snapshot on the second ready', async () => {
    const { view } = setup(rows);
    await view.handleMessage({ type: 'ready' });
    expect(posts(view)).toEqual([{ type: 'init', mode: 'slowQueries' }]);

    await view.handleMessage({ type: 'ready' });
    const snap = lastSnapshot(view);
    expect(snap.historySize).toBe(3);
    expect(snap.historyLimit).toBe(100);
    expect(snap.groups[0]).toMatchObject({ count: 2, totalMs: 400, missingConnection: false });
    expect(snap.groups.find((g: any) => g.connectionId === 'deleted').missingConnection).toBe(true);
    expect(snap.connections).toEqual([{ id: 'c1', name: 'local' }]);
  });

  it('historySize counts the entries that survive the filter', async () => {
    const { view } = setup(rows);
    await mount(view);
    expect(lastSnapshot(view).historySize).toBe(3);
    await view.handleMessage({ type: 'slowFilter', filter: { range: 'all', keyword: 'users', sort: 'total' } });
    expect(lastSnapshot(view).historySize).toBe(2);
  });

  it('fingerprints with the dialect of each entry\'s connection', async () => {
    const scanOptionsFor = vi.fn(() => ({ hashComment: true }));
    const history = new HistoryStore(memento([
      { id: 'a', sql: "SELECT * FROM t WHERE a = 'x' # one", connection: 'local', connectionId: 'c1', time: now - 1000, costTime: 5 },
      { id: 'b', sql: "SELECT * FROM t WHERE a = 'y' # two", connection: 'local', connectionId: 'c1', time: now - 5000, costTime: 5 },
    ]));
    const view: any = SlowQueryPanel.open({
      history,
      connections: () => [{ id: 'c1', name: 'local', host: 'localhost' }] as any[],
      historyLimit: () => 100,
      scanOptionsFor,
      openSql: vi.fn(async () => undefined),
      explain: vi.fn(),
    });
    await mount(view);
    const snap = lastSnapshot(view);
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0].fingerprint).toBe('SELECT * FROM t WHERE a = ?');
    expect(scanOptionsFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('closeAll (account switch) disposes the panel and stops refreshing', async () => {
    const { view, history } = setup(rows);
    await mount(view);
    SlowQueryPanel.closeAll();
    expect(SlowQueryPanel.current()).toBeUndefined();
    const before = view.post.mock.calls.length;
    await history.add({ sql: 'SELECT 9', connection: 'local', connectionId: 'c1', costTime: 1 });
    expect(view.post.mock.calls.length).toBe(before);
  });

  it('applies filters sent from the webview', async () => {
    const { view } = setup(rows);
    await mount(view);
    await view.handleMessage({ type: 'slowFilter', filter: { range: 'all', keyword: 'gone', sort: 'total' } });
    const snap = lastSnapshot(view);
    expect(snap.filter.keyword).toBe('gone');
    expect(snap.groups).toHaveLength(1);
  });

  it('refreshes when history changes', async () => {
    const { view, history } = setup([]);
    await mount(view);
    expect(lastSnapshot(view).groups).toHaveLength(0);
    await history.add({ sql: 'SELECT 1', connection: 'local', connectionId: 'c1', costTime: 5 });
    expect(lastSnapshot(view).groups).toHaveLength(1);
  });

  it('opens SQL bound to the saved connection', async () => {
    const { view, openSql } = setup(rows);
    await mount(view);
    const group = lastSnapshot(view).groups[0];
    await view.handleMessage({ type: 'slowOpenSql', key: group.key });
    expect(openSql).toHaveBeenCalledWith('SELECT * FROM users WHERE id = 1', expect.objectContaining({ id: 'c1' }), 'app');
  });

  it('opens SQL without a connection when it was deleted', async () => {
    const { view, openSql } = setup(rows);
    await mount(view);
    const group = lastSnapshot(view).groups.find((g: any) => g.connectionId === 'deleted');
    await view.handleMessage({ type: 'slowOpenSql', key: group.key });
    expect(openSql).toHaveBeenCalledWith('SELECT * FROM gone', undefined, undefined);
  });

  it('runs EXPLAIN for an existing connection and warns for a deleted one', async () => {
    const { view, explain } = setup(rows);
    await mount(view);
    const groups = lastSnapshot(view).groups;
    await view.handleMessage({ type: 'slowExplain', key: groups.find((g: any) => g.connectionId === 'c1').key });
    expect(explain).toHaveBeenCalledWith('SELECT * FROM users WHERE id = 1', expect.objectContaining({ id: 'c1' }), 'app');

    await view.handleMessage({ type: 'slowExplain', key: groups.find((g: any) => g.connectionId === 'deleted').key });
    expect(explain).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown keys', async () => {
    const { view, openSql, explain } = setup(rows);
    await mount(view);
    await view.handleMessage({ type: 'slowOpenSql', key: 'nope' });
    await view.handleMessage({ type: 'slowExplain', key: 'nope' });
    expect(openSql).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
  });

  it('is a singleton and stops listening after dispose', async () => {
    const { view, history } = setup([]);
    expect(SlowQueryPanel.current()).toBe(view);
    await mount(view);
    view.dispose();
    expect(SlowQueryPanel.current()).toBeUndefined();
    const before = view.post.mock.calls.length;
    await history.add({ sql: 'SELECT 1', connection: 'local', costTime: 1 });
    expect(view.post.mock.calls.length).toBe(before);
  });
});

describe('normalizeFilter', () => {
  it('falls back to defaults for invalid input', () => {
    expect(normalizeFilter({ sort: 'evil', range: 'forever', keyword: 42 })).toEqual({ sort: 'total', range: '7d', keyword: '' });
    expect(normalizeFilter(null)).toEqual({ sort: 'total', range: '7d', keyword: '' });
  });

  it('keeps valid values and clips the keyword', () => {
    const filter = normalizeFilter({ sort: 'avg', range: 'all', keyword: 'x'.repeat(300), connectionId: 'c1' });
    expect(filter).toMatchObject({ sort: 'avg', range: 'all', connectionId: 'c1' });
    expect(filter.keyword).toHaveLength(200);
  });
});