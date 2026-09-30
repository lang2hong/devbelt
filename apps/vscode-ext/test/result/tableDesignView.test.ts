import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: () => undefined,
  },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { title: '' };
    post = vi.fn();
    constructor(..._args: unknown[]) { /* noop */ }
    static init(): void { /* noop */ }
    dispose(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn(async (..._args: unknown[]) => true) }));
vi.mock('../../src/utils/sqlSafety', () => ({
  confirmSqlExecution: confirmMock,
  ensureWritable: () => true,
}));

import { TableDesignView } from '../../src/result/tableDesignView';

function fakeSession() {
  return {
    table: {
      addColumn: vi.fn(async () => ({})),
      modifyColumn: vi.fn(async () => ({})),
    },
    metadata: {
      getColumns: vi.fn(async () => []),
      getIndexes: vi.fn(async () => []),
    },
  };
}

function managerFor(session: ReturnType<typeof fakeSession>) {
  return {
    connectSql: vi.fn(async () => session),
    isExplicit: () => true,
    disposeConn: vi.fn(),
    retain: vi.fn(),
    retainFor: vi.fn(() => () => {}),
    release: vi.fn(),
  } as any;
}

function conn(over: Record<string, unknown> = {}) {
  return { id: 'c', name: 'prod', dbType: 'MYSQL', host: 'h', database: 'db', environment: 'development', readOnly: false, ...over } as any;
}

async function openView(connection: any) {
  const session = fakeSession();
  const manager = managerFor(session);
  await TableDesignView.open(connection, 't', 'db', manager);
  const view: any = (TableDesignView as any).current;
  return { view, session, manager };
}

describe('TableDesignView mutate gate', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    (TableDesignView as any).current = undefined;
  });

  it('development: no confirmation modal, mutation runs', async () => {
    const { view, session } = await openView(conn());
    await view.handleMessage({ type: 'addColumn', column: 'age', spec: { type: 'INT' } });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(session.table.addColumn).toHaveBeenCalledWith('t', 'age', { type: 'INT' }, 'db', undefined);
  });

  it('production: requires confirmation before running', async () => {
    confirmMock.mockResolvedValue(false);
    const { view, session, manager } = await openView(conn({ environment: 'production' }));
    await view.handleMessage({ type: 'addColumn', column: 'age', spec: { type: 'INT' } });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(manager.connectSql).not.toHaveBeenCalled();
    expect(session.table.addColumn).not.toHaveBeenCalled();
  });

  it('production + confirmed: mutation runs', async () => {
    confirmMock.mockResolvedValue(true);
    const { view, session } = await openView(conn({ environment: 'production' }));
    await view.handleMessage({ type: 'modifyColumn', column: 'age', spec: { type: 'BIGINT' } });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(session.table.modifyColumn).toHaveBeenCalledWith('t', 'age', { type: 'BIGINT' }, 'db', undefined);
  });

  it('read-only: blocked regardless of environment', async () => {
    const { view, session, manager } = await openView(conn({ readOnly: true, environment: 'production' }));
    await view.handleMessage({ type: 'addColumn', column: 'age', spec: { type: 'INT' } });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(manager.connectSql).not.toHaveBeenCalled();
    expect(session.table.addColumn).not.toHaveBeenCalled();
  });
});