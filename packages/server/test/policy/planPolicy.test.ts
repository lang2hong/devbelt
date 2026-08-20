import { describe, it, expect } from 'vitest';
import { PlanPolicy } from '../../src/policy/planPolicy.js';
import { Feature } from '../../src/domain/enums.js';
import { QuotaExceededError } from '../../src/domain/errors.js';
import { FakePlanRepo, makePlan } from '../helpers/fakeRepos.js';

function policyWith(...plans: ReturnType<typeof makePlan>[]): PlanPolicy {
  const repo = new FakePlanRepo(plans);
  return new PlanPolicy((code) => repo.findByCode(code));
}

describe('PlanPolicy.limit', () => {
  const policy = policyWith(
    makePlan('free', {
      maxDevices: 2,
      maxConnections: 10,
      syncQuotaBytes: 1024,
      historyRetentionCount: 100,
    }),
  );

  it('maps every quota type to its plan column', async () => {
    expect(await policy.limit('free', 'devices')).toBe(2);
    expect(await policy.limit('free', 'connections')).toBe(10);
    expect(await policy.limit('free', 'sync_bytes')).toBe(1024);
    expect(await policy.limit('free', 'history')).toBe(100);
  });

  it('throws when the plan row is missing', async () => {
    await expect(policy.limit('team', 'devices')).rejects.toThrow('plan not found: team');
  });
});

describe('PlanPolicy.check', () => {
  const policy = policyWith(
    makePlan('free', { maxDevices: 2 }),
    makePlan('pro', { maxDevices: 0 }),
  );

  it('allows usage below the limit', async () => {
    await expect(policy.check('free', 'devices', 1)).resolves.toBeUndefined();
  });

  /**
   * 边界语义修正。
   *
   * 原来断言「current == limit 就拒绝」。那在「current = 新增之前的已用量」
   * 语义下是对的，但两个调用方（syncService 的连接数与字节数）传的都是**写入后
   * 的总量** —— 于是实际可用上限变成 limit-1：free 宣传 5 个连接，第 5 个就被
   * 拒绝，错误信息还写着 `5/5`。
   *
   * 现在两种语义有各自的方法：checkTotal（写入后总量，<= limit 通过）与
   * checkIncrement（已用量 + delta）。check 保留为 checkTotal 的别名。
   */
  it('写入后总量恰好等于上限时通过', async () => {
    await expect(policy.checkTotal('free', 'devices', 2)).resolves.toBeUndefined();
  });

  it('写入后总量超出上限才拒绝', async () => {
    await expect(policy.checkTotal('free', 'devices', 3)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('checkIncrement 按「已用量 + delta」判定', async () => {
    // 已用 1，再加 1 = 2 <= limit 2 → 通过
    await expect(policy.checkIncrement('free', 'devices', 1)).resolves.toBeUndefined();
    // 已用 2，再加 1 = 3 > 2 → 拒绝
    await expect(policy.checkIncrement('free', 'devices', 2)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('carries quota/limit/current on the error', async () => {
    const err = await policy.checkTotal('free', 'devices', 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    const quotaErr = err as QuotaExceededError;
    expect(quotaErr.code).toBe('QUOTA_EXCEEDED');
    expect(quotaErr.quota).toBe('devices');
    expect(quotaErr.limit).toBe(2);
    expect(quotaErr.current).toBe(5);
  });

  it('treats limit 0 as unlimited', async () => {
    await expect(policy.check('pro', 'devices', 9999)).resolves.toBeUndefined();
  });
});

describe('PlanPolicy.hasFeature', () => {
  const policy = policyWith(
    makePlan('free', { features: Feature.basic }),
    makePlan('pro', { features: Feature.basic | Feature.er_export | Feature.excel }),
  );

  it('matches a single bit', async () => {
    expect(await policy.hasFeature('free', Feature.basic)).toBe(true);
    expect(await policy.hasFeature('free', Feature.er_export)).toBe(false);
    expect(await policy.hasFeature('pro', Feature.er_export)).toBe(true);
  });

  it('requires all bits of a combined mask', async () => {
    expect(await policy.hasFeature('pro', Feature.er_export | Feature.excel)).toBe(true);
    expect(await policy.hasFeature('pro', Feature.excel | Feature.audit_log)).toBe(false);
  });
});

describe('PlanPolicy.syncVersionRetention', () => {
  it('returns the plan value', async () => {
    const policy = policyWith(
      makePlan('free', { syncVersionRetention: 0 }),
      makePlan('pro', { syncVersionRetention: 10 }),
    );
    expect(await policy.syncVersionRetention('free')).toBe(0);
    expect(await policy.syncVersionRetention('pro')).toBe(10);
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