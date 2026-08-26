import { describe, expect, it } from 'vitest';
import { MysqlSeatRepo } from '../../src/repository/mysql/seatRepo.js';
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
  return new MysqlSeatRepo(() => db as unknown as MysqlDb);
}

describe('MysqlSeatRepo', () => {
  it('create 默认 status=active', async () => {
    const db = new StubDb().insertIdsSeq([11]).reply('WHERE id = ? AND delete_time', [
      { id: 11, subscription_id: 3, organization_id: 1, status: 'active', create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const s = await repo(db).create({ subscriptionId: 3, organizationId: 1 });
    expect(s).toMatchObject({ id: 11, subscriptionId: 3, organizationId: 1, status: 'active' });
    expect(db.calls[0].params).toEqual([3, 1, 'active']);
  });

  it('countActiveByOrganization 数 active 且未软删席位', async () => {
    const db = new StubDb().reply('COUNT', [{ cnt: 4 }]);
    const n = await repo(db).countActiveByOrganization(1);
    expect(n).toBe(4);
    expect(db.calls[0].sql).toContain("status = 'active'");
    expect(db.calls[0].params).toEqual([1]);
  });

  it('revoke 把 status 置为 revoked', async () => {
    const db = new StubDb();
    await repo(db).revoke(11);
    expect(db.calls[0].sql).toContain("status = 'revoked'");
    expect(db.calls[0].params).toEqual([11]);
  });
});
