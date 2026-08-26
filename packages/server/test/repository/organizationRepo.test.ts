import { describe, expect, it } from 'vitest';
import { MysqlOrganizationRepo } from '../../src/repository/mysql/organizationRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

/**
 * 极小记录桩：按特征子串匹配 SELECT 返回行集，INSERT 返回自增 id。
 * query 返回 mysql2 的 [rows, fields] 元组（与现有 repo 约定一致）。
 * 不模拟语义，只守住「发了什么 SQL + 什么参数 + 行映射是否正确」。
 */
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
  return new MysqlOrganizationRepo(() => db as unknown as MysqlDb);
}

describe('MysqlOrganizationRepo', () => {
  it('findById 软删除的行不返回（delete_time IS NULL 过滤）', async () => {
    const db = new StubDb().reply('WHERE id = ? AND delete_time IS NULL', []);
    const r = await repo(db).findById(1);
    expect(r).toBeUndefined();
    expect(db.calls[0].sql).toContain('delete_time IS NULL');
  });

  it('create 发 INSERT 并回读建好的行', async () => {
    const db = new StubDb().insertIdsSeq([42]).reply('WHERE id = ? AND delete_time', [
      { id: 42, name: 'Acme', type: 'team', owner_user_id: 7, status: 'active', create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const r = await repo(db).create({ name: 'Acme', type: 'team', ownerUserId: 7 });
    expect(r).toMatchObject({ id: 42, name: 'Acme', type: 'team', ownerUserId: 7, status: 'active' });
    expect(db.calls[0].sql).toContain('INSERT INTO organizations');
    expect(db.calls[0].params).toEqual(['Acme', 'team', 7, 'active']);
  });

  it('softDelete 用 NOW() 置 delete_time 且只改未删行', async () => {
    const db = new StubDb();
    await repo(db).softDelete(9);
    expect(db.calls[0].sql).toContain('SET delete_time = NOW()');
    expect(db.calls[0].sql).toContain('AND delete_time IS NULL');
    expect(db.calls[0].params).toEqual([9]);
  });

  it('count 只数未软删行', async () => {
    const db = new StubDb().reply('COUNT', [{ cnt: 3 }]);
    const n = await repo(db).count();
    expect(n).toBe(3);
    expect(db.calls[0].sql).toContain('WHERE delete_time IS NULL');
  });
});
