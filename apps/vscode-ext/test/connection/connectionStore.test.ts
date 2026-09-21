import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore, stripSecrets, type ConnectionTreeData, type SavedConnection } from '@devkit/db-host/connection/connectionStore';

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: () => {},
    showInformationMessage: () => {},
    createOutputChannel: () => ({ info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }),
  },
}));

function createMemento(data: ConnectionTreeData) {
  const values = new Map<string, unknown>([['devbelt.connections', data]]);
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

    expect(memento.get<ConnectionTreeData>('devbelt.connections')!.connections[0]).not.toHaveProperty('password');
    expect(await secrets.get('devbelt.connection.primary.password')).toBe('db-secret');
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

    expect(await secrets.get('devbelt.connection.primary.password')).toBeUndefined();
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
    expect(await secrets.get('devbelt.connection.c1.password')).toBe('p1');
    expect(await secrets.get('devbelt.connection.c2.password')).toBe('p2');
    expect(store.getVisibleTreeData().connections.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('ConnectionStore.removeGroupWithConnections', () => {
  it('级联删除组内（含子分组）连接并清理凭据，组外连接不受影响', async () => {
    const secrets = createSecrets();
    const store = new ConnectionStore(createMemento({
      groups: [
        { id: 'root', name: 'Root' },
        { id: 'child', name: 'Child', parentId: 'root' },
      ],
      connections: [
        conn({ id: 'c1', groupId: 'root', password: 'p1', sshPassword: 's1' }),
        conn({ id: 'c2', groupId: 'child', password: 'p2' }),
        conn({ id: 'c3' }),
      ],
    }), secrets as any);
    await store.init();

    const deleted = await store.removeGroupWithConnections('root');

    // 返回被删连接 id，供命令层关闭运行时会话
    expect(deleted.sort()).toEqual(['c1', 'c2']);
    const data = store.getTreeData();
    expect(data.groups.find((g) => g.id === 'root')!.deleted).toBe(true);
    expect(data.groups.find((g) => g.id === 'child')!.deleted).toBe(true);
    expect(data.connections.find((c) => c.id === 'c1')!.deleted).toBe(true);
    expect(data.connections.find((c) => c.id === 'c2')!.deleted).toBe(true);
    expect(data.connections.find((c) => c.id === 'c3')!.deleted).toBe(false);
    // 凭据随连接删除一并清理
    expect(await secrets.get('devbelt.connection.c1.password')).toBeUndefined();
    expect(await secrets.get('devbelt.connection.c1.sshPassword')).toBeUndefined();
    expect(await secrets.get('devbelt.connection.c2.password')).toBeUndefined();
    // 组内连接与分组均不可见，组外连接保留
    expect(store.getVisibleTreeData().groups).toHaveLength(0);
    expect(store.getVisibleTreeData().connections.map((c) => c.id)).toEqual(['c3']);
  });

  it('getGroupRemovalStats 统计子树内子分组与存活连接', async () => {
    const store = new ConnectionStore(createMemento({
      groups: [
        { id: 'root', name: 'Root' },
        { id: 'child', name: 'Child', parentId: 'root' },
      ],
      connections: [
        conn({ id: 'c1', groupId: 'root' }),
        conn({ id: 'c2', groupId: 'child' }),
        conn({ id: 'c3' }),
      ],
    }), createSecrets() as any);
    await store.init();

    expect(store.getGroupRemovalStats('root')).toEqual({ groups: 1, connections: 2 });
    // 空分组：不计自身
    expect(store.getGroupRemovalStats('child')).toEqual({ groups: 0, connections: 1 });
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

describe('ConnectionStore.addGroupRaw（导入复活墓碑）', () => {
  it('同 id 分组为墓碑时复活，组内连接随之可见', async () => {
    const store = new ConnectionStore(createMemento({
      groups: [{ id: 'g-1', name: 'Old', deleted: true }],
      connections: [conn({ id: 'c-1', groupId: 'g-1' })],
    }), createSecrets() as any);

    expect(await store.addGroupRaw('g-1', 'New Name', undefined)).toBe('revived');

    const g = store.getTreeData().groups.find((x) => x.id === 'g-1')!;
    expect(g.deleted).toBe(false);
    expect(g.name).toBe('New Name');
    expect(store.getVisibleTreeData().groups.map((x) => x.id)).toContain('g-1');
    expect(store.getVisibleTreeData().connections.map((x) => x.id)).toContain('c-1');
  });

  it('同 id 分组存活时返回 unchanged 且不改名', async () => {
    const store = new ConnectionStore(createMemento({
      groups: [{ id: 'g-1', name: 'Live', deleted: false }],
      connections: [],
    }), createSecrets() as any);

    expect(await store.addGroupRaw('g-1', 'Other')).toBe('unchanged');
    expect(store.getGroupById('g-1')!.name).toBe('Live');
  });
});

describe('stripSecrets', () => {
  it('剥离 password/sshPassword/sshPassphrase，保留其余字段与原对象', () => {
    const c = conn({ password: 'p', sshHost: 'h', sshPassword: 'sp', sshPassphrase: 'pass' });
    const out = stripSecrets(c);
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('sshPassword');
    expect(out).not.toHaveProperty('sshPassphrase');
    expect(out.host).toBe('localhost');
    expect(out.sshHost).toBe('h');
    expect(c.password).toBe('p');
    expect(c.sshPassphrase).toBe('pass');
  });
});
