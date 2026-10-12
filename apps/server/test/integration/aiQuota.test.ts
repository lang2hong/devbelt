import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations, LEGACY_MIGRATION_VERSIONS } from '../../src/repository/mysql/migrations/index.js';
import { withTransaction, type MysqlDb } from '../../src/repository/mysql/db.js';
import { MysqlAiUsageRepo } from '../../src/modules/ai/repository/aiUsageRepo.js';
import { AiQuotaService } from '../../src/modules/ai/service/aiQuotaService.js';
import { AiQuotaExceededError } from '../../src/modules/ai/domain/errors.js';
import { FakePlanRepo, FakePersonalSubscriptionRepo, makeFreePlan } from '../helpers/fakeRepos.js';
import type { Plan } from '../../src/domain/entities.js';

const URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;

/**
 * ai_token_usage 真库验证（P9 §6.8/§6.9）：migration 种子幂等、ensure-row 首次并发、
 * FOR UPDATE 预占不超发、settle 无符号下溢防护。无真库环境时整体跳过。
 */
describe.skipIf(!URL)('AI 月额度账本（real MySQL）', () => {
  const USER = 990_001;
  const USER_ENSURE = 990_002;
  const MONTH = '2026-10';

  let pool: ReturnType<typeof createTestPool>;
  let db: MysqlDb;
  let repo: MysqlAiUsageRepo;
  let quota: AiQuotaService;

  beforeAll(async () => {
    pool = createTestPool();
    db = pool as unknown as MysqlDb;
    await runMigrations(db, [...migrations], LEGACY_MIGRATION_VERSIONS);
    repo = new MysqlAiUsageRepo(() => db);

    const plans = new FakePlanRepo([makeFreePlan()]);
    const free = plans.plans.find((p: Plan) => p.code === 'free')!;
    free.features = { ...free.features, maxAiTokensMonthly: 1000 };
    quota = new AiQuotaService(
      repo,
      new FakePersonalSubscriptionRepo(),
      plans,
      (fn) => withTransaction(db, fn),
      () => new Date('2026-10-15T00:00:00Z'),
    );
    await pool.query('DELETE FROM ai_token_usage WHERE user_id IN (?, ?)', [USER, USER_ENSURE]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM ai_token_usage WHERE user_id IN (?, ?)', [USER, USER_ENSURE]);
    await pool.end();
  });

  it('migration 008：maxAiTokensMonthly 已按 free=100K / pro=2M 幂等入种子', async () => {
    const [rows] = (await pool.query(
      `SELECT p.code AS code, v.value_json AS value_json
         FROM plans p
         JOIN plan_feature_values v ON v.plan_id = p.id
         JOIN plan_feature_defs d ON d.id = v.feature_def_id
        WHERE d.feature_key = 'maxAiTokensMonthly'`,
    )) as [Array<{ code: string; value_json: unknown }>, unknown];
    const byCode = new Map(
      rows.map((r) => [r.code, typeof r.value_json === 'string' ? JSON.parse(r.value_json) : r.value_json]),
    );
    expect(byCode.get('free')).toBe(100_000);
    expect(byCode.get('pro')).toBe(2_000_000);

    // 重跑 migration 幂等：不追加定义/取值行。
    await runMigrations(db, [...migrations], LEGACY_MIGRATION_VERSIONS);
    const [again] = (await pool.query(
      `SELECT COUNT(*) AS c FROM plan_feature_defs WHERE feature_key = 'maxAiTokensMonthly'`,
    )) as [Array<{ c: number }>, unknown];
    expect(Number(again[0].c)).toBe(1);
  });

  it('ensure-row 首次并发：唯一键 + ON DUPLICATE KEY 无冲突，仅一行', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => withTransaction(db, (tx) => repo.ensureRowInTx(tx, USER_ENSURE, MONTH))),
    );
    const [rows] = (await pool.query(
      'SELECT COUNT(*) AS c FROM ai_token_usage WHERE user_id = ? AND usage_month = ?',
      [USER_ENSURE, MONTH],
    )) as [Array<{ c: number }>, unknown];
    expect(Number(rows[0].c)).toBe(1);
  });

  it('FOR UPDATE 预占不超发：limit 1000、20 并发各 200 → 恰 5 成功 15 个 409', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        quota.reserve(USER, { estimatedPromptTokens: 100, maxCompletionTokens: 100 }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toBe(5);
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.reason instanceof AiQuotaExceededError)).toBe(true);

    const row = await repo.find(USER, MONTH);
    expect(row!.reservedPromptTokens + row!.reservedCompletionTokens).toBe(1000);
    expect(row!.promptTokens + row!.completionTokens).toBe(0);
  });

  it('settle 用 LEAST 释放预占：release > reserved 不触发无符号下溢', async () => {
    await withTransaction(db, (tx) => repo.ensureRowInTx(tx, USER_ENSURE, MONTH));
    await withTransaction(db, (tx) => repo.addReservationInTx(tx, USER_ENSURE, MONTH, 50, 50));
    await expect(
      withTransaction(db, (tx) =>
        repo.settleInTx(tx, USER_ENSURE, MONTH, {
          releaseReservedPromptTokens: 999,
          releaseReservedCompletionTokens: 999,
          promptTokens: 10,
          completionTokens: 5,
        }),
      ),
    ).resolves.toBeUndefined();

    const row = await repo.find(USER_ENSURE, MONTH);
    expect(row).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      reservedPromptTokens: 0,
      reservedCompletionTokens: 0,
      requestCount: 1,
    });
  });
});