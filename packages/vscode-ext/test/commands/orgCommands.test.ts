import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerOrgCommands } from '../../src/commands/org';
import { OrgApiError } from '../../src/org/client';
import { OrgTreeNode } from '../../src/tree/orgTreeDataProvider';

const mocks = vi.hoisted(() => {
  const commandHandlers = new Map<string, (...a: any[]) => any>();
  return {
    commandHandlers,
    window: {
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showOpenDialog: vi.fn(),
      activeTextEditor: undefined as any,
      showTextDocument: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose() {} })),
    },
    workspace: {
      openTextDocument: vi.fn(),
      onDidCloseTextDocument: vi.fn(() => ({ dispose() {} })),
      getConfiguration: vi.fn(() => ({ get: (_key: string, d: any) => d })),
    },
    commands: {
      registerCommand: vi.fn((cmd: string, h: any) => { commandHandlers.set(cmd, h); return { dispose() {} }; }),
      executeCommand: vi.fn(async () => {}),
    },
    env: { language: 'en' },
  };
});

vi.mock('vscode', () => ({
  window: mocks.window,
  workspace: mocks.workspace,
  commands: mocks.commands,
  env: mocks.env,
  TreeItem: class {
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  ThemeColor: class {},
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
  Range: class {
    constructor(public startLine: any, public startChar: any, public endLine: any, public endChar: any) {}
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

const DOC_URI = 'doc:/uri1';
const tplSummary = {
  resourceId: 'r1', resourceType: 'connection_template', name: 'tpl', folderId: null,
  version: 1, createdByMembershipId: '1', updatedByMembershipId: null,
} as const;
const querySummary = {
  resourceId: 'r1', resourceType: 'query', name: 'q', folderId: null,
  version: 1, createdByMembershipId: '1', updatedByMembershipId: null,
} as const;

function tplNode(role: 'admin' | 'member' = 'admin'): OrgTreeNode {
  return new OrgTreeNode('tpl', 0, 'resource', 'o1', undefined, { ...tplSummary }, role);
}
function queryNode(role: 'admin' | 'member' = 'admin'): OrgTreeNode {
  return new OrgTreeNode('q', 0, 'resource', 'o1', undefined, { ...querySummary }, role);
}

/** 复位 vscode window/workspace mock 到测试需要的确定性实现。 */
function installEditorMocks(): void {
  for (const fn of [
    mocks.window.showInputBox, mocks.window.showQuickPick, mocks.window.showWarningMessage,
    mocks.window.showInformationMessage, mocks.window.showErrorMessage, mocks.window.showOpenDialog,
  ]) {
    fn.mockReset();
  }
  mocks.workspace.openTextDocument.mockReset();
  mocks.workspace.openTextDocument.mockImplementation(async (opts: any) => {
    const doc: any = {
      uri: { toString: () => DOC_URI },
      text: opts.content ?? '',
      getText: () => doc.text,
      lineCount: 1,
      positionAt: (i: number) => ({ line: 0, character: i }),
    };
    return doc;
  });
  mocks.window.showTextDocument.mockReset();
  mocks.window.showTextDocument.mockImplementation(async (doc: any) => {
    const editor = {
      document: doc,
      selection: { isEmpty: true },
      edit: vi.fn(async (cb: any) => cb({ replace: (_r: any, text: string) => { doc.text = text; } })),
    };
    mocks.window.activeTextEditor = editor;
    return editor;
  });
  mocks.window.activeTextEditor = undefined;
}

describe('dbclient.org.connectTemplate 行为', () => {
  let workspace: any;
  let manager: any;
  let vault: any;
  let handlers: Map<string, (...a: any[]) => any>;

  beforeEach(() => {
    mocks.commandHandlers.clear();
    vault = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clearAll: vi.fn(async () => {}),
    };
    workspace = {
      getResource: vi.fn(),
      updateResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      listOrganizations: vi.fn(),
      listFolders: vi.fn(),
      vault,
      waitForCleanup: vi.fn(async () => {}),
    };
    manager = { connect: vi.fn(async () => {}) };
    registerOrgCommands({
      context: { subscriptions: { push: vi.fn() } },
      workspace,
      manager,
      executor: { run: vi.fn(async () => {}) },
      tree: { refresh: vi.fn() },
    } as any);
    handlers = mocks.commandHandlers;
    installEditorMocks();
  });

  it('非 mysql 模板：不读取/写入 vault、不调用 connect，弹提示', async () => {
    workspace.getResource.mockResolvedValue({
      ...querySummary, resourceType: 'connection_template',
      content: { databaseType: 'postgresql', host: 'h', port: 1, database: 'd' },
    });
    mocks.window.showWarningMessage.mockResolvedValue(undefined);

    await handlers.get('dbclient.org.connectTemplate')!(tplNode());

    expect(mocks.window.showWarningMessage).toHaveBeenCalled();
    expect(vault.get).not.toHaveBeenCalled();
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it('verify-ca 取消 CA 选择：不建连、不持久化凭据', async () => {
    workspace.getResource.mockResolvedValue({
      ...tplSummary,
      content: { databaseType: 'mysql', host: 'h', port: 1, database: 'd', ssl: { mode: 'verify-ca' } },
    });
    mocks.window.showInputBox.mockResolvedValue('u');
    mocks.window.showOpenDialog.mockResolvedValue(undefined);

    await handlers.get('dbclient.org.connectTemplate')!(tplNode());

    expect(vault.set).not.toHaveBeenCalled();
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it('建连失败：清除已持久化凭据并提示，不产生未处理 rejection', async () => {
    workspace.getResource.mockResolvedValue({
      ...tplSummary,
      content: { databaseType: 'mysql', host: 'h', port: 1, database: 'd', username: 'u' },
    });
    vault.get.mockResolvedValue({ password: 'p' });
    manager.connect.mockRejectedValue(new Error('auth failed'));

    await handlers.get('dbclient.org.connectTemplate')!(tplNode());

    expect(vault.delete).toHaveBeenCalledWith('o1', 'r1');
    expect(mocks.window.showErrorMessage).toHaveBeenCalled();
  });
});

describe('dbclient.org.saveResource 409 冲突行为', () => {
  let workspace: any;
  let vault: any;
  let handlers: Map<string, (...a: any[]) => any>;

  beforeEach(() => {
    mocks.commandHandlers.clear();
    vault = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clearAll: vi.fn() };
    workspace = {
      getResource: vi.fn(),
      updateResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      listOrganizations: vi.fn(),
      listFolders: vi.fn(),
      vault,
      waitForCleanup: vi.fn(async () => {}),
    };
    registerOrgCommands({
      context: { subscriptions: { push: vi.fn() } },
      workspace,
      manager: { connect: vi.fn() },
      executor: { run: vi.fn() },
      tree: { refresh: vi.fn() },
    } as any);
    handlers = mocks.commandHandlers;
    installEditorMocks();
  });

  async function openQuery(role: 'admin' | 'member' = 'admin'): Promise<void> {
    workspace.getResource.mockResolvedValueOnce({ ...querySummary, content: { sql: 'select 1' } });
    await handlers.get('dbclient.org.openResource')!(queryNode(role));
  }

  it('Overwrite：以 currentVersion 为重发 baseVersion', async () => {
    await openQuery('admin');
    workspace.updateResource
      .mockRejectedValueOnce(new OrgApiError(409, 'RESOURCE_VERSION_CONFLICT', 'stale', 9))
      .mockResolvedValueOnce({ resourceId: 'r1', version: 10 });
    mocks.window.showWarningMessage.mockResolvedValue('Overwrite');

    await handlers.get('dbclient.org.saveResource')!();

    expect(workspace.updateResource).toHaveBeenCalledTimes(2);
    expect(workspace.updateResource.mock.calls[1][2].baseVersion).toBe(9);
    expect(mocks.window.showInformationMessage).toHaveBeenCalled();
  });

  it('Cancel：不再发起第二次请求', async () => {
    await openQuery('admin');
    workspace.updateResource.mockRejectedValue(new OrgApiError(409, 'RESOURCE_VERSION_CONFLICT', 'stale', 9));
    mocks.window.showWarningMessage.mockResolvedValue(undefined);

    await handlers.get('dbclient.org.saveResource')!();

    expect(workspace.updateResource).toHaveBeenCalledTimes(1);
  });

  it('Refresh：强制拉取并替换编辑器文本与 baseVersion', async () => {
    await openQuery('admin');
    workspace.updateResource.mockRejectedValue(new OrgApiError(409, 'RESOURCE_VERSION_CONFLICT', 'stale', 9));
    workspace.getResource.mockResolvedValue({ ...querySummary, version: 10, content: { sql: 'select 999' } });
    mocks.window.showWarningMessage.mockResolvedValue('Refresh');

    await handlers.get('dbclient.org.saveResource')!();

    expect(workspace.getResource).toHaveBeenCalledWith('o1', 'r1', true);
    expect(mocks.window.activeTextEditor.document.getText()).toBe('select 999');
  });

  it('Overwrite 再次 409：不产生未处理 rejection，走 showError', async () => {
    await openQuery('admin');
    workspace.updateResource.mockRejectedValue(new OrgApiError(409, 'RESOURCE_VERSION_CONFLICT', 'stale', 9));
    mocks.window.showWarningMessage.mockResolvedValue('Overwrite');

    await expect(handlers.get('dbclient.org.saveResource')!()).resolves.toBeUndefined();
    expect(mocks.window.showErrorMessage).toHaveBeenCalled();
  });

  it('Refresh 遇 403：不产生未处理 rejection，走 showError', async () => {
    await openQuery('admin');
    workspace.updateResource.mockRejectedValue(new OrgApiError(409, 'RESOURCE_VERSION_CONFLICT', 'stale', 9));
    workspace.getResource.mockRejectedValue(new OrgApiError(403, 'FORBIDDEN', 'denied'));
    mocks.window.showWarningMessage.mockResolvedValue('Refresh');

    await expect(handlers.get('dbclient.org.saveResource')!()).resolves.toBeUndefined();
    expect(mocks.window.showErrorMessage).toHaveBeenCalled();
  });
});
