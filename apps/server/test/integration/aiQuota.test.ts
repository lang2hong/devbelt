import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool } from './testDb.js';
import { runMigrations } from '../../src/repository/mysql/migrate.js';
import { migrations, LEGACY_MIGRATION_VERSIONS } from '../../src/repository/mysql/migrations/index.js';
import { withTransaction, type MysqlDb } from '../../src/repository/mysql/db.js';
import { MysqlAiUsageRepo } from '../../src/modules/ai/repository/aiUsageRepo.js';
import { MysqlAiTopupRepo } from '../../src/modules/ai/repository/aiTopupRepo.js';
import { MysqlUserRepo } from '../../src/modules/auth/repository/userRepo.js';
import { AiTopupService } from '../../src/modules/ai/service/aiTopupService.js';
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
      new MysqlAiTopupRepo(() => db),
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

  it('migration 013：maxAiTokensMonthly 已按 free=200K / pro=1M 幂等入种子', async () => {
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
    expect(byCode.get('free')).toBe(200_000);
    expect(byCode.get('pro')).toBe(1_000_000);

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

/**
 * P9.1 加油包真库验证：migration 009 种子、双重来源履约幂等（uq_grants_order）、
 * 双段 FIFO（月额度耗尽后由 grants 承接）。无真库环境时跳过。
 */
describe.skipIf(!URL)('AI 加油包账本（real MySQL，P9.1）', () => {
  /** 真实 users 行由 beforeAll 创建（orders.user_id 有外键，不能用凭空的固定 id）。 */
  let USER_T = 0;

  let pool: ReturnType<typeof createTestPool>;
  let db: MysqlDb;
  let topupRepo: MysqlAiTopupRepo;
  let quota: AiQuotaService;

  beforeAll(async () => {
    pool = createTestPool();
    db = pool as unknown as MysqlDb;
    await runMigrations(db, [...migrations], LEGACY_MIGRATION_VERSIONS);
    const userRepo = new MysqlUserRepo(() => db);
    USER_T = (await userRepo.create(`ai-topup-${Date.now()}@example.com`, 'hash', 'AI Topup')).id;
    topupRepo = new MysqlAiTopupRepo(() => db);
    const plans = new FakePlanRepo([makeFreePlan()]);
    const free = plans.plans.find((p: Plan) => p.code === 'free')!;
    // FIFO 用例需要月段先耗尽：给一个小于单次预占（800）的月额度。
    free.features = { ...free.features, maxAiTokensMonthly: 500 };
    quota = new AiQuotaService(
      new MysqlAiUsageRepo(() => db),
      topupRepo,
      new FakePersonalSubscriptionRepo(),
      plans,
      (fn) => withTransaction(db, fn),
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM ai_quota_grants WHERE user_id = ?', [USER_T]);
    await db.query("DELETE FROM orders WHERE purpose = 'topup' AND user_id = ?", [USER_T]);
    await db.query('DELETE FROM ai_token_usage WHERE user_id = ?', [USER_T]);
    await db.query('DELETE FROM users WHERE id = ?', [USER_T]);
    await pool.end();
  });

  it('migration 009：SKU 种子存在且 orders 扩列生效', async () => {
    const skus = await topupRepo.listActiveSkus();
    // migration 013：500 档停用，新增 1,000/5,000 积分档；按 sort_order 返回。
    expect(skus.map((s) => s.code)).toEqual(['topup_1m', 'topup_2m', 'topup_5m', 'topup_10m']);
    const [cols] = await db.query<any[]>('SHOW COLUMNS FROM orders LIKE ?', ['purpose']);
    expect(cols).toHaveLength(1);
  });

  it('手工建单 + fulfill 重放：uq_grants_order 幂等（仅一行账本）', async () => {
    const service = new AiTopupService(topupRepo, (fn) => withTransaction(db, fn));
    const created = await service.createManualOrder({ userId: USER_T, skuCode: 'topup_1m' });
    expect(created.grantInserted).toBe(true);
    const [orderRows] = await db.query<any[]>('SELECT id FROM orders WHERE order_no = ?', [created.orderNo]);
    const orderId = Number(orderRows[0]!.id);
    const [rows] = await db.query<any[]>('SELECT COUNT(*) AS cnt FROM ai_quota_grants WHERE user_id = ?', [USER_T]);
    expect(Number(rows[0]!.cnt)).toBe(1);
    // 重放 insertGrant（模拟回调重放）：uq_grants_order 挡住 → false（幂等锚点）
    const insertedAgain = await withTransaction(db, (tx) =>
      topupRepo.insertGrantInTx(tx, {
        userId: USER_T,
        orderId,
        skuCode: 'topup_1m',
        tokens: 1_000_000,
        expiresTime: new Date('2026-12-31T00:00:00Z'),
      }),
    );
    expect(insertedAgain).toBe(false);
  });

  it('双段 FIFO：月额度耗尽后由 grants 承接预占与结算', async () => {
    const grants = await topupRepo.lockActiveInTx({ query: db.query.bind(db) } as never, USER_T, new Date('2026-10-15T00:00:00Z'));
    expect(grants.length).toBeGreaterThan(0);
    const available = await topupRepo.availability(USER_T, new Date('2026-10-15T00:00:00Z'));
    expect(available.remaining).toBeGreaterThan(0);
    const reservation = await quota.reserve(USER_T, { estimatedPromptTokens: 800, maxCompletionTokens: 0 });
    // 月额度 500 先吃满，余下 300 由 grants 承接。
    expect(reservation.reservedPromptTokens).toBe(500);
    expect(reservation.grantAllocations.length).toBe(1);
    expect(reservation.grantAllocations[0]!.tokens).toBe(300);
    await quota.settle(reservation, { promptTokens: 800, completionTokens: 0 });
    const after = await topupRepo.availability(USER_T, new Date('2026-10-15T00:00:00Z'));
    // availability 只统计 grants：月段 500 已耗尽，grants 扣 300。
    expect(after.remaining).toBe(available.remaining - reservation.grantAllocations[0]!.tokens);
  });
});
