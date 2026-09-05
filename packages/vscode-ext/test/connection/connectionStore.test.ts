import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore, type ConnectionTreeData, type SavedConnection } from '../../src/connection/connectionStore';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: () => {},
    showInformationMessage: () => {},
    createOutputChannel: () => ({ info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }),
  },
}));

function createMemento(data: ConnectionTreeData) {
  const values = new Map<string, unknown>([['dbclient.connections', data]]);
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

function createSecrets() {
  const values = new Map<string, string>();
  return {
    async get(key: string): Promise<string | undefined> { return values.get(key); },
    async store(key: string, value: string): Promise<void> { values.set(key, value); },
    async delete(key: string): Promise<void> { values.delete(key); },
  };
}

function conn(over: Partial<SavedConnection>): SavedConnection {
  return {
    id: 'primary', name: 'Primary', dbType: 'MYSQL' as any,
    host: 'localhost', port: 3306, user: 'root',
    ...over,
  } as SavedConnection;
}

describe('ConnectionStore sync model', () => {
  it('migrates legacy credentials to SecretStorage and includes them in sync payload', async () => {
    const memento = createMemento({ groups: [], connections: [conn({ password: 'db-secret', sshPassword: 'ssh-secret' })] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);

    await store.init();

    expect(memento.get<ConnectionTreeData>('dbclient.connections')!.connections[0]).not.toHaveProperty('password');
    expect(await secrets.get('dbclient.connection.primary.password')).toBe('db-secret');
    expect(store.get('primary')!.password).toBe('db-secret');
  });

  it('materializes a saved password back into the connection', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.save(conn({ password: 'db-secret' }));

    expect(store.get('primary')!.password).toBe('db-secret');
    expect(store.list()[0].password).toBe('db-secret');
  });

it('clears an existing password when saving an empty value', async () => {
    const memento = createMemento({ groups: [], connections: [] });
    const secrets = createSecrets();
    const store = new ConnectionStore(memento, secrets as any);
    await store.save(conn({ password: 'db-secret' }));

    await store.save(conn({ password: '' }));

    expect(await secrets.get('dbclient.connection.primary.password')).toBeUndefined();
    expect(store.get('primary')!.password).toBeUndefined();
  });
});

/**
 * 墓碑必须留在持久层（删除要能同步到其他设备），但不能出现在 UI。
 * 树视图与各类选择器过去直接用 getTreeData()，导致删掉的连接/分组仍然渲染。
 */
describe('ConnectionStore.getVisibleTreeData', () => {
  function storeWith(data: ConnectionTreeData) {
    return new ConnectionStore(createMemento(data), createSecrets() as any);
  }

  it('剔除软删除的连接，保留存活的', () => {
    const store = storeWith({
      groups: [],
      connections: [
        conn({ id: 'alive', name: 'Alive' }),
        conn({ id: 'gone', name: 'Gone', deleted: true }),
      ],
    });

    const visible = store.getVisibleTreeData();
    expect(visible.connections.map((c) => c.id)).toEqual(['alive']);
  });

  it('剔除软删除的分组，保留存活的', () => {
    const store = storeWith({
      groups: [
        { id: 'g-alive', name: 'Alive', createTime: 1, updateTime: 1, deleted: false },
        { id: 'g-gone', name: 'Gone', createTime: 1, updateTime: 1, deleted: true },
      ],
      connections: [],
    });

    expect(store.getVisibleTreeData().groups.map((g) => g.id)).toEqual(['g-alive']);
  });

  it('getTreeData 仍然返回墓碑（同步合并依赖）', () => {
    const store = storeWith({
      groups: [{ id: 'g-gone', name: 'Gone', createTime: 1, updateTime: 1, deleted: true }],
      connections: [conn({ id: 'gone', deleted: true })],
    });

    expect(store.getTreeData().connections).toHaveLength(1);
    expect(store.getTreeData().groups).toHaveLength(1);
    expect(store.getVisibleTreeData().connections).toHaveLength(0);
    expect(store.getVisibleTreeData().groups).toHaveLength(0);
  });

  it('保留 groupId/parentId 以便层级组装', () => {
    const store = storeWith({
      groups: [
        { id: 'root', name: 'Root', createTime: 1, updateTime: 1, deleted: false },
        { id: 'child', name: 'Child', parentId: 'root', createTime: 1, updateTime: 1, deleted: false },
      ],
      connections: [conn({ id: 'in-group', groupId: 'child' })],
    });

    const visible = store.getVisibleTreeData();
    expect(visible.groups.find((g) => g.id === 'child')!.parentId).toBe('root');
    expect(visible.connections[0].groupId).toBe('child');
  });

  it('与 remove() 联动：删除后不再可见但墓碑仍在', async () => {
    const store = storeWith({ groups: [], connections: [conn({ id: 'primary' })] });

    await store.remove('primary');

    expect(store.getVisibleTreeData().connections).toHaveLength(0);
    expect(store.getTreeData().connections.find((c) => c.id === 'primary')!.deleted).toBe(true);
  });
});

describe('ConnectionStore.removeGroup', () => {
  it('删除父分组：tombstone 分组树，成员连接移未分组（不删除连接）', async () => {
    const secrets = createSecrets();
    const store = new ConnectionStore(createMemento({
      groups: [
        { id: 'root', name: 'Root' },
        { id: 'child', name: 'Child', parentId: 'root' },
      ],
      connections: [
        conn({ id: 'c1', groupId: 'root', password: 'p1' }),
        conn({ id: 'c2', groupId: 'child', password: 'p2' }),
        conn({ id: 'c3' }),
      ],
    }), secrets as any);
    await store.init();

    await store.removeGroup('root');

    const data = store.getTreeData();
    expect(data.groups.find((g) => g.id === 'root')!.deleted).toBe(true);
    expect(data.groups.find((g) => g.id === 'child')!.deleted).toBe(true);
    // 连接本身不被删除，仅解除分组
    expect(data.connections.find((c) => c.id === 'c1')!.deleted).toBe(false);
    expect(data.connections.find((c) => c.id === 'c1')!.groupId).toBeUndefined();
    expect(data.connections.find((c) => c.id === 'c2')!.deleted).toBe(false);
    expect(data.connections.find((c) => c.id === 'c2')!.groupId).toBeUndefined();
    expect(data.connections.find((c) => c.id === 'c3')!.deleted).toBe(false);
    // 凭据保留（连接未被删除）
    expect(await secrets.get('dbclient.connection.c1.password')).toBe('p1');
    expect(await secrets.get('dbclient.connection.c2.password')).toBe('p2');
    expect(store.getVisibleTreeData().connections.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('ConnectionStore change source', () => {
  it('group and move methods preserve an explicit sync source', async () => {
    const store = new ConnectionStore(createMemento({
      groups: [{ id: 'g-1', name: 'Old' }],
      connections: [conn({ id: 'c-1' })],
    }), createSecrets() as any);
    const sources: string[] = [];
    store.onChanged((source) => sources.push(source));

    await store.moveToGroup('c-1', 'g-1', 'sync');
    await store.addGroup('New', undefined, 'sync');
    await store.addGroupRaw('g-raw', 'Raw', undefined, 'sync');
    await store.renameGroup('g-1', 'Renamed', 'sync');

    expect(sources).toEqual(['sync', 'sync', 'sync', 'sync']);
  });

  it('group and move methods default their source to user', async () => {
    const store = new ConnectionStore(createMemento({
      groups: [{ id: 'g-1', name: 'Old' }],
      connections: [conn({ id: 'c-1' })],
    }), createSecrets() as any);
    const sources: string[] = [];
    store.onChanged((source) => sources.push(source));

    await store.moveToGroup('c-1', 'g-1');
    await store.addGroup('New');
    await store.addGroupRaw('g-raw', 'Raw');
    await store.renameGroup('g-1', 'Renamed');

    expect(sources).toEqual(['user', 'user', 'user', 'user']);
  });
});
