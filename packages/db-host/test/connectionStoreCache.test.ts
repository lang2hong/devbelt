import { describe, expect, it } from 'vitest';
import { ConnectionStore, type SavedConnection } from '../src/connection/connectionStore.js';

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(k: string): T | undefined => store.get(k) as T | undefined,
    async update(k: string, v: unknown) { store.set(k, v); },
  };
}

function secretsWithEvents() {
  const map = new Map<string, string>();
  const listeners: Array<(e: { key: string }) => void> = [];
  return {
    map,
    emit: (key: string) => listeners.forEach((l) => l({ key })),
    async get(k: string) { return map.get(k); },
    async store(k: string, v: string) { map.set(k, v); },
    async delete(k: string) { map.delete(k); },
    onDidChange(l: (e: { key: string }) => void) { listeners.push(l); return { dispose: () => {} }; },
  };
}

const conn: SavedConnection = {
  id: 'c1', name: 'C', dbType: 'MYSQL' as SavedConnection['dbType'], host: 'h', port: 3306, user: 'u', database: 'd',
};

/**
 * 跨窗口场景：SecretStorage 由多个窗口共享，B 窗口改密后 A 窗口的缓存必须刷新，
 * 否则 A 会用旧密码登录、并在保存时把旧值写回覆盖新值。
 */
describe('ConnectionStore 跨窗口密钥缓存', () => {
  it('外部密钥变更后 materialize 返回新值', async () => {
    const sec = secretsWithEvents();
    const store = new ConnectionStore(memento() as never, sec);

    await store.save({ ...conn, password: 'old' });
    expect(store.get('c1')!.password).toBe('old');

    sec.map.set('devbelt.connection.c1.password', 'new');
    sec.emit('devbelt.connection.c1.password');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get('c1')!.password).toBe('new');
  });
});