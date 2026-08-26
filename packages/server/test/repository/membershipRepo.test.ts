import { describe, expect, it } from 'vitest';
import { MysqlMembershipRepo } from '../../src/repository/mysql/membershipRepo.js';
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
  return new MysqlMembershipRepo(() => db as unknown as MysqlDb);
}

describe('MysqlMembershipRepo', () => {
  it('create 默认 status=active', async () => {
    const db = new StubDb().insertIdsSeq([5]).reply('WHERE id = ? AND delete_time', [
      { id: 5, organization_id: 1, user_id: 2, role: 'member', status: 'active', create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const m = await repo(db).create({ organizationId: 1, userId: 2, role: 'member' });
    expect(m).toMatchObject({ id: 5, organizationId: 1, userId: 2, role: 'member', status: 'active' });
    expect(db.calls[0].params).toEqual([1, 2, 'member', 'active']);
  });

  it('countActiveByOrganization 过滤 status=active 且未软删', async () => {
    const db = new StubDb().reply('COUNT', [{ cnt: 2 }]);
    const n = await repo(db).countActiveByOrganization(1);
    expect(n).toBe(2);
    expect(db.calls[0].sql).toContain("status = 'active'");
    expect(db.calls[0].sql).toContain('delete_time IS NULL');
    expect(db.calls[0].params).toEqual([1]);
  });

  it('updateRole 改 role 列', async () => {
    const db = new StubDb();
    await repo(db).updateRole(5, 'admin');
    expect(db.calls[0].sql).toContain('UPDATE memberships SET role = ?');
    expect(db.calls[0].params).toEqual(['admin', 5]);
  });

  it('findByOrgAndUser 复合条件查询', async () => {
    const db = new StubDb().reply('AND user_id = ?', [
      { id: 9, organization_id: 1, user_id: 2, role: 'admin', status: 'active', create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const m = await repo(db).findByOrgAndUser(1, 2);
    expect(m?.id).toBe(9);
    expect(m?.role).toBe('admin');
  });
});
