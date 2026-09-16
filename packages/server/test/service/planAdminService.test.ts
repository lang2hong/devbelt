import { describe, expect, it } from 'vitest';
import { ConsoleAdminService } from '../../src/service/consoleAdminService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { ValidationError, PlanVersionConflictError } from '../../src/domain/errors.js';
import type { PlanFeatureDef } from '../../src/domain/entities.js';
import type { Queryable } from '../../src/repository/mysql/db.js';
import {
  FakeUserRepo,
  FakeRefreshTokenRepo,
  FakePlanRepo,
  FakePlanFeatureDefRepo,
  FakePersonalSubscriptionRepo,
  FakeOrganizationRepo,
  FakeOrganizationSubscriptionRepo,
  FakeMembershipRepo,
} from '../helpers/fakeRepos.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';

const DEFS: PlanFeatureDef[] = [
  { id: 1, key: 'maxSavedConnections', kind: 'personal', label: { en: 'Saved', zh: '保存' }, valueType: 'number', unit: 'count', sortOrder: 10 },
  { id: 2, key: 'allowConnectionImport', kind: 'personal', label: { en: 'Import', zh: '导入' }, valueType: 'bool', unit: null, sortOrder: 20 },
  { id: 3, key: 'includedSeats', kind: 'organization', label: { en: 'Seats', zh: '席位' }, valueType: 'number', unit: 'seat', sortOrder: 30 },
];

function makeService() {
  const planRepo = new FakePlanRepo();
  const featureDefRepo = new FakePlanFeatureDefRepo(DEFS);
  const svc = new ConsoleAdminService({
    userRepo: new FakeUserRepo(),
    refreshTokenRepo: new FakeRefreshTokenRepo(),
    planRepo,
    featureDefRepo,
    personalSubscriptionRepo: new FakePersonalSubscriptionRepo(),
    organizationRepo: new FakeOrganizationRepo(),
    organizationSubscriptionRepo: new FakeOrganizationSubscriptionRepo(),
    membershipRepo: new FakeMembershipRepo(),
    auditRepo: new FakeAuditRepo(),
    orderRepo: {} as never,
    invoiceRepo: {} as never,
    auditWriter: new AuditWriter(new FakeAuditRepo()),
  });
  return { svc, planRepo, featureDefRepo };
}

const TX = {} as Queryable;

describe('ConsoleAdminService.updatePlanInTx', () => {
  it('saves meta + features, bumps version once, and audits', async () => {
    const { svc, planRepo } = makeService();
    const pro = (await planRepo.findByCode('pro'))!;
    const initialVersion = pro.version;
    const updated = await svc.updatePlanInTx(TX, 1, {
      id: pro.id, name: 'Pro+', priceCents: 12900, billingUnit: 'month', sortOrder: 5, status: 'active',
      features: [{ featureKey: 'maxSavedConnections', value: 200 }, { featureKey: 'allowConnectionImport', value: true }],
      expectedVersion: initialVersion, reason: 'pricing update',
    });
    expect(updated.name).toBe('Pro+');
    expect(updated.priceCents).toBe(12900);
    expect(updated.version).toBe(initialVersion + 1);
    expect(updated.features).toEqual({ maxSavedConnections: 200, allowConnectionImport: true });
  });

  it('rejects a stale expectedVersion with PlanVersionConflictError', async () => {
    const { svc, planRepo } = makeService();
    const pro = (await planRepo.findByCode('pro'))!;
    await expect(svc.updatePlanInTx(TX, 1, {
      id: pro.id, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [], expectedVersion: pro.version + 99, reason: 'x',
    })).rejects.toBeInstanceOf(PlanVersionConflictError);
  });

  it('rejects an unknown feature key', async () => {
    const { svc, planRepo } = makeService();
    const pro = (await planRepo.findByCode('pro'))!;
    await expect(svc.updatePlanInTx(TX, 1, {
      id: pro.id, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [{ featureKey: 'doesNotExist', value: 1 }], expectedVersion: pro.version, reason: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a NaN/invalid feature value (fail-open channel)', async () => {
    const { svc, planRepo } = makeService();
    const pro = (await planRepo.findByCode('pro'))!;
    await expect(svc.updatePlanInTx(TX, 1, {
      id: pro.id, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [{ featureKey: 'maxSavedConnections', value: NaN }], expectedVersion: pro.version, reason: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects duplicate feature keys', async () => {
    const { svc, planRepo } = makeService();
    const pro = (await planRepo.findByCode('pro'))!;
    await expect(svc.updatePlanInTx(TX, 1, {
      id: pro.id, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [{ featureKey: 'maxSavedConnections', value: 1 }, { featureKey: 'maxSavedConnections', value: 2 }],
      expectedVersion: pro.version, reason: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a feature that does not apply to the plan kind', async () => {
    const { svc, planRepo } = makeService();
    const pro = (await planRepo.findByCode('pro'))!;
    await expect(svc.updatePlanInTx(TX, 1, {
      id: pro.id, name: 'Pro', priceCents: 9900, billingUnit: 'month', sortOrder: 0, status: 'active',
      features: [{ featureKey: 'includedSeats', value: 3 }], expectedVersion: pro.version, reason: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to archive the fallback (free) plan', async () => {
    const { svc, planRepo } = makeService();
    const free = (await planRepo.findByCode('free'))!;
    await expect(svc.updatePlanInTx(TX, 1, {
      id: free.id, name: 'Free', priceCents: 0, billingUnit: 'month', sortOrder: 0, status: 'archived',
      features: [], expectedVersion: free.version, reason: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
    // 仍为 active
    expect((await planRepo.findByCode('free'))!.status).toBe('active');
  });
});

describe('ConsoleAdminService.upsertFeatureDefInTx', () => {
  it('creates a new feature def and validates input', async () => {
    const { svc, featureDefRepo } = makeService();
    const created = await svc.upsertFeatureDefInTx(TX, 1, {
      key: 'maxElasticNodes', kind: 'personal', label: { en: 'Elastic nodes', zh: 'ES 节点' },
      valueType: 'number', unit: 'count', sortOrder: 70, reason: 'add es',
    });
    expect(created.key).toBe('maxElasticNodes');
    expect(await featureDefRepo.findByKey('maxElasticNodes')).toBeTruthy();

    await expect(svc.upsertFeatureDefInTx(TX, 1, {
      key: 'bad key', kind: 'personal', label: { en: 'x', zh: 'x' }, valueType: 'number', unit: null, sortOrder: 0, reason: 'x',
    })).rejects.toBeInstanceOf(ValidationError);
  });
});