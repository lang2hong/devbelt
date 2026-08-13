import { describe, expect, it } from 'vitest';
import { computeMergePlan, totalChanges, totalLocalOnly } from '../../src/sync/mergePlan';
import type { SyncPayload } from '../../src/sync/syncPayload';
import type { SavedConnection } from '../../src/connection/connectionStore';
import type { SavedQuery } from '@db-client/core';

function conn(over: Partial<SavedConnection>): SavedConnection {
  return { id: 'c1', name: 'C', dbType: 'MYSQL' as any, host: 'h', port: 3306, user: 'u', ...over } as SavedConnection;
}
function query(over: Partial<SavedQuery>): SavedQuery {
  return { id: 'q1', name: 'Q', sql: 'SELECT 1', connId: 'c1', database: 'app', createTime: 0, updateTime: 0, deleted: false, ...over };
}
function payload(over: Partial<SyncPayload>): SyncPayload {
  return { version: 1, groups: [], connections: [], queries: [], queryFolders: [], history: [], ...over };
}

describe('computeMergePlan', () => {
  it('marks remote-only connections as added', () => {
    const plan = computeMergePlan(payload({}), payload({ connections: [conn({ id: 'c1', name: 'Remote' })] }));
    expect(plan.connections.added).toBe(1);
    expect(plan.connections.items[0].kind).toBe('added');
    expect(plan.connections.localOnly).toBe(0);
  });

  it('marks local-only connections as localOnly (kept, not a change)', () => {
    const plan = computeMergePlan(payload({ connections: [conn({ id: 'c1', name: 'Local' })] }), payload({}));
    expect(plan.connections.localOnly).toBe(1);
    expect(plan.connections.added).toBe(0);
    expect(totalLocalOnly(plan)).toBe(1);
    expect(totalChanges(plan)).toBe(0);
  });

  it('marks remote-newer connections as updated', () => {
    const plan = computeMergePlan(
      payload({ connections: [conn({ id: 'c1', updateTime: 100 })] }),
      payload({ connections: [conn({ id: 'c1', updateTime: 200 })] }),
    );
    expect(plan.connections.updated).toBe(1);
  });

  it('keeps local when local is newer (no change)', () => {
    const plan = computeMergePlan(
      payload({ connections: [conn({ id: 'c1', updateTime: 200 })] }),
      payload({ connections: [conn({ id: 'c1', updateTime: 100 })] }),
    );
    expect(plan.connections.updated).toBe(0);
    expect(totalChanges(plan)).toBe(0);
  });

  it('delete wins: remote tombstone marks local connection as deleted', () => {
    const plan = computeMergePlan(
      payload({ connections: [conn({ id: 'c1', updateTime: 200 })] }),
      payload({ connections: [conn({ id: 'c1', deleted: true, updateTime: 100 })] }),
    );
    expect(plan.connections.deleted).toBe(1);
    expect(plan.connections.items[0].kind).toBe('deleted');
  });

  it('skips remote-only tombstones for non-existent local items', () => {
    const plan = computeMergePlan(payload({}), payload({ connections: [conn({ id: 'c1', deleted: true })] }));
    expect(plan.connections.added).toBe(0);
    expect(plan.connections.deleted).toBe(0);
  });

  it('categorizes saved query diffs independently from connections', () => {
    const plan = computeMergePlan(
      payload({ queries: [query({ id: 'q1', updateTime: 100 })] }),
      payload({ queries: [query({ id: 'q2', updateTime: 100 })] }),
    );
    expect(plan.queries.localOnly).toBe(1);
    expect(plan.queries.added).toBe(1);
  });

  it('history merge counts added and merged by id', () => {
    const plan = computeMergePlan(
      payload({ history: [{ id: 'h1', sql: 'a', connection: 'c', time: 1, costTime: 1 }] }),
      payload({ history: [
        { id: 'h1', sql: 'a', connection: 'c', time: 1, costTime: 1 },
        { id: 'h2', sql: 'b', connection: 'c', time: 2, costTime: 1 },
      ] }),
    );
    expect(plan.history.added).toBe(1);
    expect(plan.history.merged).toBe(1);
  });

  it('totalChanges sums all section deltas', () => {
    const plan = computeMergePlan(
      payload({ connections: [conn({ id: 'c2', updateTime: 1 })] }),
      payload({
        connections: [conn({ id: 'c1', name: 'New' }), conn({ id: 'c2', deleted: true })],
        history: [{ id: 'h9', sql: 'x', connection: 'c', time: 9, costTime: 1 }],
      }),
    );
    // connections: c1 added, c2 deleted → 2; history: h9 added → 1
    expect(totalChanges(plan)).toBe(3);
  });
});
