import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const on = (name: string) => (fn: (e: any) => void) => {
    (listeners[name] ??= []).push(fn);
    return { dispose: () => { listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn); } };
  };
  const collection = {
    set: vi.fn(),
    delete: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    listeners,
    on,
    collection,
    config: { enabled: true, rules: {} as Record<string, unknown> },
    docs: [] as any[],
  };
});

vi.mock('vscode', () => {
  class Range { constructor(public start: any, public end: any) {} }
  class Diagnostic {
    source?: string;
    code?: string;
    constructor(public range: any, public message: string, public severity: number) {}
  }
  return {
    Range,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    env: { language: 'en' },
    languages: { createDiagnosticCollection: () => h.collection },
    window: { onDidChangeActiveTextEditor: h.on('active') },
    workspace: {
      get textDocuments() { return h.docs; },
      onDidOpenTextDocument: h.on('open'),
      onDidChangeTextDocument: h.on('change'),
      onDidCloseTextDocument: h.on('close'),
      onDidChangeConfiguration: h.on('config'),
      getConfiguration: (section?: string) => ({
        get: (key: string, d: unknown) => {
          if (section === 'devbelt.diagnostics') return key === 'enabled' ? h.config.enabled : h.config.rules;
          return d;
        },
      }),
    },
  };
});

import { SqlDiagnosticsProvider, MAX_LINT_CHARS, LINT_DEBOUNCE_MS } from '../../src/diagnostics/sqlDiagnosticsProvider';

function doc(text: string, languageId = 'sql', uri = 'file:///a.sql'): any {
  return {
    languageId,
    uri: { toString: () => uri },
    getText: () => text,
    positionAt: (o: number) => ({ offset: o }),
  };
}

function lastSet(): any[] {
  const calls = h.collection.set.mock.calls;
  return calls.length ? calls[calls.length - 1][1] : [];
}

beforeEach(() => {
  for (const k of Object.keys(h.listeners)) delete h.listeners[k];
  h.collection.set.mockClear();
  h.collection.delete.mockClear();
  h.config.enabled = true;
  h.config.rules = {};
  h.docs = [];
  vi.useRealTimers();
});

function make(dbType?: string) {
  return new SqlDiagnosticsProvider({ resolveDbType: () => dbType as any, resolveScanOptions: () => undefined });
}

describe('SqlDiagnosticsProvider', () => {
  it('lints open SQL documents on start and ignores other languages', () => {
    h.docs = [doc('DELETE FROM t'), doc('DELETE FROM t', 'plaintext', 'file:///b.txt')];
    make();
    expect(h.collection.set).toHaveBeenCalledTimes(1);
    const [d] = lastSet();
    expect(d).toMatchObject({ source: 'DevBelt', code: 'updateDeleteWithoutWhere', severity: 1 });
    expect(d.range.start.offset).toBe(0);
    expect(d.range.end.offset).toBe(6);
  });

  it('clears diagnostics when disabled', () => {
    h.config.enabled = false;
    make().refresh(doc('DELETE FROM t'));
    expect(h.collection.set).not.toHaveBeenCalled();
    expect(h.collection.delete).toHaveBeenCalled();
  });

  it('skips oversized documents', () => {
    make().refresh(doc(`DELETE FROM t;${' '.repeat(MAX_LINT_CHARS)}`));
    expect(h.collection.set).not.toHaveBeenCalled();
    expect(h.collection.delete).toHaveBeenCalled();
  });

  it('debounces edits', () => {
    vi.useFakeTimers();
    make();
    const d = doc('DELETE FROM t');
    h.listeners.change[0]({ document: d });
    h.listeners.change[0]({ document: d });
    expect(h.collection.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LINT_DEBOUNCE_MS);
    expect(h.collection.set).toHaveBeenCalledTimes(1);
  });

  it('clears diagnostics when a document closes', () => {
    make();
    const d = doc('DELETE FROM t');
    h.listeners.close[0](d);
    expect(h.collection.delete).toHaveBeenCalledWith(d.uri);
  });

  it('re-lints on diagnostics configuration changes only', () => {
    h.docs = [doc('SELECT * FROM t')];
    make();
    h.collection.set.mockClear();
    h.listeners.config[0]({ affectsConfiguration: (s: string) => s === 'devbelt.ai' });
    expect(h.collection.set).not.toHaveBeenCalled();
    h.config.rules = { selectStar: 'off' };
    h.listeners.config[0]({ affectsConfiguration: (s: string) => s === 'devbelt.diagnostics' });
    expect(h.collection.set).toHaveBeenCalledTimes(1);
    expect(lastSet()).toEqual([]);
  });

  it('enables dialect rules from the bound connection', () => {
    make('PG').refresh(doc('SELECT `a` FROM t WHERE x = 1'));
    expect(lastSet().map((d: any) => d.code)).toEqual(['dialectMismatch']);
  });

  it('re-lints when the active editor changes', () => {
    make();
    h.listeners.active[0]({ document: doc('DROP TABLE t') });
    expect(lastSet().map((d: any) => d.code)).toEqual(['dangerousDdl']);
  });
});