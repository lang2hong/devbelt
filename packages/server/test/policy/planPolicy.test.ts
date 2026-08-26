import { describe, it, expect } from 'vitest';
import { PlanPolicy } from '../../src/policy/planPolicy.js';
import { Feature } from '../../src/domain/enums.js';
import { QuotaExceededError } from '../../src/domain/errors.js';
import { makePlan } from '../helpers/fakeRepos.js';
import type { Plan } from '../../src/domain/entities.js';

/** 构造一个所有用户都解析到同一组有效席位的 PlanPolicy */
function policyWith(plans: Plan[]): PlanPolicy {
  return new PlanPolicy(async () => plans);
}

describe('PlanPolicy.limit', () => {
  const policy = policyWith([
    makePlan('free', {
      perSeatMaxDevices: 2,
      perUserMaxPrivateConnections: 10,
      perUserPrivateSyncQuotaBytes: 1024,
      perUserHistoryRetentionCount: 100,
    }),
  ]);

  it('maps every quota type to its plan column', async () => {
    expect(await policy.limit(1, 'devices')).toBe(2);
    expect(await policy.limit(1, 'connections')).toBe(10);
    expect(await policy.limit(1, 'sync_bytes')).toBe(1024);
    expect(await policy.limit(1, 'history')).toBe(100);
  });

  it('取多席位套餐中的最高值', async () => {
    const multi = policyWith([
      makePlan('free', { perSeatMaxDevices: 2 }),
      makePlan('pro', { perSeatMaxDevices: 5 }),
    ]);
    expect(await multi.limit(1, 'devices')).toBe(5);
  });

  it('任一席位的 0（无限）即整体无限', async () => {
    const multi = policyWith([
      makePlan('free', { perSeatMaxDevices: 2 }),
      makePlan('pro', { perSeatMaxDevices: 0 }),
    ]);
    expect(await multi.limit(1, 'devices')).toBe(0);
  });

  it('throws when 无有效席位（数据完整性问题）', async () => {
    const empty = policyWith([]);
    await expect(empty.limit(1, 'devices')).rejects.toThrow('no effective plan');
  });
});

describe('PlanPolicy.checkTotal / checkIncrement', () => {
  const policy = policyWith([
    makePlan('free', { perSeatMaxDevices: 2 }),
    makePlan('pro', { perSeatMaxDevices: 0 }),
  ]);
  // 只给 free 席位
  const freeOnly = policyWith([makePlan('free', { perSeatMaxDevices: 2 })]);

  it('写入后总量恰好等于上限时通过', async () => {
    await expect(freeOnly.checkTotal(1, 'devices', 2)).resolves.toBeUndefined();
  });

  it('写入后总量超出上限才拒绝', async () => {
    await expect(freeOnly.checkTotal(1, 'devices', 3)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('checkIncrement 按「已用量 + delta」判定', async () => {
    await expect(freeOnly.checkIncrement(1, 'devices', 1)).resolves.toBeUndefined();
    await expect(freeOnly.checkIncrement(1, 'devices', 2)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('carries quota/limit/current on the error', async () => {
    const err = await freeOnly.checkTotal(1, 'devices', 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    const quotaErr = err as QuotaExceededError;
    expect(quotaErr.code).toBe('QUOTA_EXCEEDED');
    expect(quotaErr.quota).toBe('devices');
    expect(quotaErr.limit).toBe(2);
    expect(quotaErr.current).toBe(5);
  });

  it('treats limit 0 as unlimited', async () => {
    await expect(policy.checkTotal(1, 'devices', 9999)).resolves.toBeUndefined();
  });
});

describe('PlanPolicy.hasFeature', () => {
  const policy = policyWith([
    makePlan('free', { features: Feature.basic }),
    makePlan('pro', { features: Feature.basic | Feature.er_export | Feature.excel }),
  ]);
  const freeOnly = policyWith([makePlan('free', { features: Feature.basic })]);

  it('matches a single bit', async () => {
    expect(await freeOnly.hasFeature(1, Feature.basic)).toBe(true);
    expect(await freeOnly.hasFeature(1, Feature.er_export)).toBe(false);
    expect(await policy.hasFeature(1, Feature.er_export)).toBe(true);
  });

  it('requires all bits of a combined mask across any seat', async () => {
    expect(await policy.hasFeature(1, Feature.er_export | Feature.excel)).toBe(true);
    expect(await policy.hasFeature(1, Feature.excel | Feature.audit_log)).toBe(false);
  });
});

describe('PlanPolicy.syncVersionRetention', () => {
  it('returns 有效席位中的最高值', async () => {
    const policy = policyWith([
      makePlan('free', { perUserSyncVersionRetention: 10 }),
      makePlan('pro', { perUserSyncVersionRetention: 30 }),
    ]);
    expect(await policy.syncVersionRetention(1)).toBe(30);
  });
});

/**
 * 回归：Feature 必须在**编译产物**里真实存在。
 *
 * 它曾是 `const enum`，tsc 会完全擦除：`dist/domain/enums.js` 只导出
 * SECTION_TYPES，`dist/policy/planPolicy.js` 也没有 `export { Feature }`，
 * 运行时 `import { Feature }` 得到 undefined。vitest 走 esbuild 能跑通，
 * 编译产物不能 —— 典型的「测试绿、上线炸」。
 */
describe('Feature 运行时可用性', () => {
  it('是运行时对象而非被擦除的 const enum', () => {
    expect(typeof Feature).toBe('object');
    expect(Feature).not.toBeUndefined();
  });

  it('七个位值互不重叠且为 2 的幂', () => {
    const values = Object.values(Feature);
    expect(values).toHaveLength(7);
    expect(new Set(values).size).toBe(7);
    for (const v of values) {
      expect(Number.isInteger(Math.log2(v))).toBe(true);
    }
  });

  it('位掩码组合可用（客户端按位与的前提）', () => {
    const pro = Feature.basic | Feature.er_export | Feature.excel;
    expect(pro & Feature.er_export).toBe(Feature.er_export);
    expect(pro & Feature.audit_log).toBe(0);
  });

  it('可枚举（Object.keys 拿得到名字，供诊断/日志用）', () => {
    expect(Object.keys(Feature)).toContain('er_export');
    expect(Object.keys(Feature)).toContain('audit_log');
  });
});