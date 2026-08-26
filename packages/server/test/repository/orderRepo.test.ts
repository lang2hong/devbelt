import { describe, expect, it } from 'vitest';
import { MysqlOrderRepo } from '../../src/repository/mysql/orderRepo.js';
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
  return new MysqlOrderRepo(() => db as unknown as MysqlDb);
}

describe('MysqlOrderRepo', () => {
  it('create 把 subscriptionId/externalId 的 undefined 归一为 null', async () => {
    const db = new StubDb().insertIdsSeq([7]).reply('WHERE id = ?', [
      { id: 7, organization_id: 1, subscription_id: null, plan_id: 2, amount: 20, currency: 'CNY', status: 'paid', provider: 'manual', external_id: null, seat_delta: 1, period_months: 1, create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    await repo(db).create({
      organizationId: 1,
      subscriptionId: undefined,
      planId: 2,
      amount: 20,
      currency: 'CNY',
      status: 'paid',
      provider: 'manual',
      externalId: undefined,
      seatDelta: 1,
      periodMonths: 1,
    });
    expect(db.calls[0].sql).toContain('INSERT INTO orders');
    // subscription_id(→null) ... external_id(→null) 在 NULL 位
    expect(db.calls[0].params).toEqual([1, null, 2, 20, 'CNY', 'paid', 'manual', null, 1, 1]);
  });

  it('create 保留显式 subscriptionId / externalId', async () => {
    const db = new StubDb().insertIdsSeq([8]).reply('WHERE id = ?', [
      { id: 8, organization_id: 1, subscription_id: 9, plan_id: 2, amount: 200, currency: 'CNY', status: 'paid', provider: 'stripe', external_id: 'evt_1', seat_delta: 2, period_months: 12, create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    await repo(db).create({
      organizationId: 1,
      subscriptionId: 9,
      planId: 2,
      amount: 200,
      currency: 'CNY',
      status: 'paid',
      provider: 'stripe',
      externalId: 'evt_1',
      seatDelta: 2,
      periodMonths: 12,
    });
    expect(db.calls[0].params).toEqual([1, 9, 2, 200, 'CNY', 'paid', 'stripe', 'evt_1', 2, 12]);
  });

  it('findByProviderExternal 按 (provider, external_id) 查幂等', async () => {
    const db = new StubDb().reply('external_id = ?', [
      { id: 8, organization_id: 1, subscription_id: 9, plan_id: 2, amount: 200, currency: 'CNY', status: 'paid', provider: 'stripe', external_id: 'evt_1', seat_delta: 2, period_months: 12, create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const o = await repo(db).findByProviderExternal('stripe', 'evt_1');
    expect(o?.id).toBe(8);
    expect(o?.amount).toBe(200);
    expect(o?.seatDelta).toBe(2);
    expect(db.calls[0].params).toEqual(['stripe', 'evt_1']);
  });

  it('listByOrganization 按 id DESC 分页', async () => {
    const db = new StubDb().reply('organization_id = ?', [
      { id: 3, organization_id: 1, subscription_id: null, plan_id: 1, amount: 0, currency: 'CNY', status: 'paid', provider: 'manual', external_id: null, seat_delta: 0, period_months: 1, create_time: '2026-01-01', update_time: '2026-01-01' },
    ]);
    const list = await repo(db).listByOrganization(1, 50, 0);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(3);
    expect(db.calls[0].sql).toContain('ORDER BY id DESC');
    expect(db.calls[0].sql).toContain('LIMIT ? OFFSET ?');
  });
});
