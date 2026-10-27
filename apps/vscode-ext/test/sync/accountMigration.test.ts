import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { markMigrationAsked, migrateScope, migrationMarker, migrationOffer } from '../../src/sync/accountMigration';

function memento(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get<T>(key: string): T | undefined { return data[key] as T | undefined; },
    update(key: string, value: unknown): Thenable<void> { data[key] = value; return Promise.resolve(); },
  };
}

describe('account migration (B1)', () => {
  it('未登录或问过之后不再询问', () => {
    const m = memento({ 'devbelt.connections': [{ id: 'c1' }] });
    expect(migrationOffer(m as never, 'local').needed).toBe(false);
    expect(migrationOffer(m as never, 'u1')).toEqual({ needed: true, connections: 1 });
    m.data[migrationMarker('u1')] = true;
    expect(migrationOffer(m as never, 'u1').needed).toBe(false);
  });

  it('账号已有连接时不询问（不重复复制）', () => {
    const m = memento({
      'devbelt.connections': [{ id: 'c1' }],
      'devbelt.connections::u.u1': [{ id: 'c2' }],
    });
    expect(migrationOffer(m as never, 'u1').needed).toBe(false);
  });

  it('复制连接/历史/审计，原数据保留；不覆盖账号已有值', async () => {
    const m = memento({
      'devbelt.connections': [{ id: 'c1' }],
      'devbelt.history': [{ sql: 'select 1' }],
      'devbelt.auditLog': [{ id: 'a1' }],
      'devbelt.history::u.u1': [{ sql: 'mine' }],
    });
    await migrateScope(m as never, 'u1');
    expect(m.data['devbelt.connections::u.u1']).toEqual([{ id: 'c1' }]);
    expect(m.data['devbelt.history::u.u1']).toEqual([{ sql: 'mine' }]);
    expect(m.data['devbelt.auditLog::u.u1']).toEqual([{ id: 'a1' }]);
    expect(m.data['devbelt.connections']).toEqual([{ id: 'c1' }]);
  });

  it('记录「已询问」后 offer 消失', async () => {
    const m = memento({ 'devbelt.connections': [{ id: 'c1' }] });
    await markMigrationAsked(m as never, 'u1');
    expect(migrationOffer(m as never, 'u1').needed).toBe(false);
  });
});
