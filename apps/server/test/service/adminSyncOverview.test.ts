import { describe, it, expect } from 'vitest';
import { ConsoleAdminService } from '../../src/modules/admin/service/consoleAdminService.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';

function makeSvc(over: { user?: unknown; state?: unknown; rows?: unknown[] } = {}) {
  return new ConsoleAdminService({
    userRepo: { findById: async () => over.user } as never,
    refreshTokenRepo: {} as never,
    planRepo: {} as never,
    featureDefRepo: {} as never,
    personalSubscriptionRepo: {} as never,
    auditRepo: {} as never,
    orderRepo: {} as never,
    invoiceRepo: {} as never,
    auditWriter: new AuditWriter(new FakeAuditRepo()),
    syncStateRepo: { findByUserId: async () => over.state } as never,
    syncRecordService: { overviewByKind: async () => over.rows ?? [] } as never,
  });
}

describe('P6-S6 ConsoleAdminService.getSyncKindOverview', () => {
  it('returns per-kind ciphertext metadata (no plaintext fields)', async () => {
    const svc = makeSvc({
      user: { id: 1 },
      state: { keyEpoch: '1' },
      rows: [{ entityKind: 'authenticatorEntry', count: 2, bytes: 128, lastActivityTime: null }],
    });
    const rows = await svc.getSyncKindOverview(9, 1);
    expect(rows).toEqual([{ entityKind: 'authenticatorEntry', count: 2, bytes: 128, lastActivityTime: null }]);
    // 只含元数据字段，不含密文/明文
    expect(Object.keys(rows[0]).sort()).toEqual(['bytes', 'count', 'entityKind', 'lastActivityTime']);
  });

  it('returns [] when the user has no sync state', async () => {
    const svc = makeSvc({ user: { id: 1 }, state: undefined });
    expect(await svc.getSyncKindOverview(9, 1)).toEqual([]);
  });

  it('throws NOT_FOUND for an unknown user', async () => {
    const svc = makeSvc({ user: undefined });
    await expect(svc.getSyncKindOverview(9, 999)).rejects.toThrow(/not found/);
  });
});
