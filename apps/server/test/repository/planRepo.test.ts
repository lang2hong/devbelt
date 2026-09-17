import { describe, expect, it } from 'vitest';
import { MysqlPlanRepo, MysqlPlanFeatureDefRepo } from '../../src/modules/billing/repository/planRepo.js';

/** 极简脚本化 exec（saveInTx 只用 exec.query）。 */
function scriptedExec(affected: number[]) {
  let i = 0;
  return {
    query: async () => [{ affectedRows: affected[i++] ?? 0 }, undefined] as any,
  };
}

describe('MysqlPlanRepo.saveInTx', () => {
  it('throws when a feature key is unknown (never silently drops features)', async () => {
    // UPDATE(1) → DELETE(1) → INSERT(0: unknown key)
    const exec = scriptedExec([1, 1, 0]);
    const repo = new MysqlPlanRepo(() => ({} as never));
    await expect(repo.saveInTx(exec as never, {
      id: 1, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [{ featureKey: 'nope', value: 1 }], expectedVersion: 0,
    })).rejects.toThrow(/unknown feature_key/);
  });

  it('returns false when the version CAS misses', async () => {
    const exec = scriptedExec([0]);
    const repo = new MysqlPlanRepo(() => ({} as never));
    await expect(repo.saveInTx(exec as never, {
      id: 1, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [], expectedVersion: 7,
    })).resolves.toBe(false);
  });

  it('clears the process cache on a successful save', async () => {
    // 首次读：plans 行 + features 行（脚本化 db）。
    let calls = 0;
    const db = {
      query: async (sql: string) => {
        calls += 1;
        if (sql.includes('FROM plans')) {
          return [[{ id: 1, code: 'pro', kind: 'personal', name: 'Pro', price_cents: 9900, billing_unit: 'month', sort_order: 0, status: 'active', version: 0, create_time: new Date(), update_time: new Date() }], undefined];
        }
        return [[], undefined];
      },
    };
    const cached = new MysqlPlanRepo(() => db as never);
    await cached.findById(1);
    const afterFirst = calls;
    await cached.findById(1); // cache hit → no query
    expect(calls).toBe(afterFirst);

    // save（同实例）→ 清缓存
    const exec = scriptedExec([1]);
    await cached.saveInTx(exec as never, { id: 1, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active', features: [], expectedVersion: 0 });
    await cached.findById(1);
    expect(calls).toBeGreaterThan(afterFirst);
  });
});

describe('MysqlPlanRepo cache isolation and invalidation', () => {
  it('cache is per-instance: a second instance still queries the DB', async () => {
    const planRow = { id: 1, code: 'pro', kind: 'personal', name: 'Pro', price_cents: 9900, billing_unit: 'month', sort_order: 0, status: 'active', version: 0, create_time: new Date(), update_time: new Date() };
    let calls = 0;
    const makeDb = () => ({ query: async (sql: string) => { calls += 1; return [sql.includes('FROM plans') ? [planRow] : [], undefined] as any; } });

    const a = new MysqlPlanRepo(() => makeDb() as never);
    await a.findById(1);
    const afterA = calls;

    const b = new MysqlPlanRepo(() => makeDb() as never);
    await b.findById(1);
    expect(calls).toBeGreaterThan(afterA); // b 未共享 a 的缓存
  });

  it('invalidate clears the entry so the next read hits the DB', async () => {
    const planRow = { id: 1, code: 'pro', kind: 'personal', name: 'Pro', price_cents: 9900, billing_unit: 'month', sort_order: 0, status: 'active', version: 0, create_time: new Date(), update_time: new Date() };
    let calls = 0;
    const db = { query: async (sql: string) => { calls += 1; return [sql.includes('FROM plans') ? [planRow] : [], undefined] as any; } };
    const repo = new MysqlPlanRepo(() => db as never);
    await repo.findById(1);
    const afterFirst = calls;
    await repo.findById(1);
    expect(calls).toBe(afterFirst); // 缓存命中
    repo.invalidate(1);
    await repo.findById(1);
    expect(calls).toBeGreaterThan(afterFirst); // 失效后走库
  });
});

describe('MysqlPlanFeatureDefRepo.findByKeyInTx', () => {
  it('reads through the passed exec, never the pool', async () => {
    const pool = { query: async () => { throw new Error('pool must not be used inside a tx'); } };
    const repo = new MysqlPlanFeatureDefRepo(() => pool as never);
    const exec = {
      query: async () => [[{ id: 1, feature_key: 'maxSavedConnections', kind: 'personal', label_json: { en: 'Saved', zh: '保存' }, value_type: 'number', unit: 'count', sort_order: 0 }], undefined] as any,
    };
    const def = await repo.findByKeyInTx(exec as never, 'maxSavedConnections');
    expect(def?.key).toBe('maxSavedConnections');
  });
});