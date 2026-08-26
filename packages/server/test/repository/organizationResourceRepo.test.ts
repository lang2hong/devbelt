import { describe, expect, it } from 'vitest';
import { MysqlOrganizationResourceRepo } from '../../src/repository/mysql/organizationResourceRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

/** 见 organizationRepo.test.ts 的桩设计说明。 */
class StubDb {
  readonly database = 'stub';
  calls: Array<{ sql: string; params?: any[] }> = [];
  private selects: Array<{ marker: string; rows: any[] }> = [];
  private insertIds: number[] = [];
  private counter = 0;

  reply(marker: string, rows: any[]): this {
    this.selects.push({ marker, rows });
    return this;
  }
  insertIdsSeq(ids: number[]): this {
    this.insertIds = ids;
    return this;
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T> {
    this.calls.push({ sql, params });
    for (const { marker, rows } of this.selects) {
      if (sql.includes(marker)) return [rows, []] as unknown as T;
    }
    if (sql.trimStart().startsWith('INSERT')) {
      this.counter++;
      const id = this.insertIds.shift() ?? this.counter;
      return [{ insertId: id, affectedRows: 1 }, []] as unknown as T;
    }
    return [{ affectedRows: 1 }, []] as unknown as T;
  }
  async getConnection() {
    throw new Error('not used');
  }
}

function repo(db: StubDb) {
  return new MysqlOrganizationResourceRepo(() => db as unknown as MysqlDb);
}

describe('MysqlOrganizationResourceRepo', () => {
  it('create 后回读并映射 created_by_user_id / access_scope', async () => {
    const db = new StubDb().insertIdsSeq([1]).reply('WHERE id = ? AND delete_time', [
      { id: 1, organization_id: 1, resource_type: 'query', name: 'q1', access_scope: 'restricted', encrypted_data: 'enc', created_by_user_id: 7, updated_by_user_id: null, create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const r = await repo(db).create({
      organizationId: 1,
      resourceType: 'query',
      name: 'q1',
      accessScope: 'restricted',
      encryptedData: 'enc',
      createdByUserId: 7,
    });
    expect(r).toMatchObject({ id: 1, resourceType: 'query', accessScope: 'restricted', createdByUserId: 7, updatedByUserId: undefined });
  });

  it('update 只拼入参出现的字段', async () => {
    const db = new StubDb();
    await repo(db).update(1, { name: 'q2', updatedByUserId: 9 });
    expect(db.calls[0].sql).toContain('name = ?');
    expect(db.calls[0].sql).toContain('updated_by_user_id = ?');
    expect(db.calls[0].sql).not.toContain('access_scope');
    expect(db.calls[0].params).toEqual(['q2', 9, 1]);
  });

  it('listByOrganization 带 type 时加 resource_type 过滤', async () => {
    const db = new StubDb().reply('resource_type = ?', []);
    await repo(db).listByOrganization(1, 'folder');
    expect(db.calls[0].sql).toContain('resource_type = ?');
    expect(db.calls[0].params).toEqual([1, 'folder']);
  });

  it('listByOrganization 不带 type 时不加 resource_type 条件', async () => {
    const db = new StubDb().reply('organization_id = ?', []);
    await repo(db).listByOrganization(1);
    expect(db.calls[0].sql).not.toContain('resource_type = ?');
  });

  it('grantPermission 走 ON DUPLICATE KEY UPDATE 后回读', async () => {
    const db = new StubDb().reply('AND membership_id = ?', [
      { id: 5, organization_id: 1, resource_id: 2, membership_id: 3, permission: 'write', create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const p = await repo(db).grantPermission(1, 2, 3, 'write');
    expect(db.calls[0].sql).toContain('ON DUPLICATE KEY UPDATE permission = VALUES(permission)');
    expect(db.calls[0].params).toEqual([1, 2, 3, 'write']);
    expect(p).toMatchObject({ id: 5, permission: 'write' });
  });

  it('revokePermission 按复合键删除', async () => {
    const db = new StubDb();
    await repo(db).revokePermission(2, 3);
    expect(db.calls[0].sql).toContain('DELETE FROM organization_resource_permissions');
    expect(db.calls[0].params).toEqual([2, 3]);
  });
});
