import { describe, expect, it } from 'vitest';
import type { IUserRepo } from '../../src/repository/interfaces.js';
import type { User, AuditEvent } from '../../src/domain/entities.js';
import { AuditWriter } from '../../src/service/auditWriter.js';
import { bootstrapPlatformAdmins, promotePlatformAdmin, normalizeEmail } from '../../src/service/platformAdminBootstrap.js';

function makeUser(over: Partial<User> = {}): User {
  return {
    id: 7,
    email: 'admin@example.com',
    emailVerifiedTime: new Date(),
    passwordHash: 'x',
    status: 'active',
    role: 'user',
    lastLoginTime: null,
    sessionVersion: 1,
    createTime: new Date(),
    updateTime: new Date(),
    ...over,
  };
}

function harness(user?: User) {
  const setRoleCalls: Array<[number, string]> = [];
  const audits: AuditEvent[] = [];
  const warnings: string[] = [];
  const repo = {
    findByEmail: async (email: string) => (user ? ({ ...user, email } as User) : undefined),
    setRole: async (id: number, role: string) => { setRoleCalls.push([id, role]); },
  } as unknown as IUserRepo;
  const auditWriter = new AuditWriter(
    {
      insert: async (event: Omit<AuditEvent, 'id' | 'createTime'>) => { audits.push({ ...event, id: audits.length + 1, createTime: new Date() } as AuditEvent); return {} as AuditEvent; },
      insertInTx: async () => ({} as AuditEvent),
    } as never,
    () => {},
  );
  const warn = (msg: string) => { warnings.push(msg); };
  return { repo, auditWriter, setRoleCalls, audits, warnings, warn };
}

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
  });
});

describe('promotePlatformAdmin', () => {
  it('grants to a verified + active user and writes an audit event', async () => {
    const h = harness(makeUser());
    const result = await promotePlatformAdmin(h.repo, h.auditWriter, 'Admin@Example.com', h.warn);
    expect(result).toEqual({ kind: 'granted', userId: 7 });
    expect(h.setRoleCalls).toEqual([[7, 'platform_admin']]);
    expect(h.audits.map((a) => a.eventType)).toContain('admin.role.granted');
  });

  it('refuses an unverified account and does not call setRole', async () => {
    const h = harness(makeUser({ emailVerifiedTime: null }));
    const result = await promotePlatformAdmin(h.repo, h.auditWriter, 'admin@example.com', h.warn);
    expect(result).toEqual({ kind: 'not-verified', userId: 7 });
    expect(h.setRoleCalls).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.warnings.join(' ')).toMatch(/not email-verified/);
  });

  it('refuses a non-active account', async () => {
    const h = harness(makeUser({ status: 'disabled' }));
    const result = await promotePlatformAdmin(h.repo, h.auditWriter, 'admin@example.com', h.warn);
    expect(result).toEqual({ kind: 'not-active', userId: 7 });
    expect(h.setRoleCalls).toEqual([]);
  });

  it('warns and refuses when no user matches', async () => {
    const h = harness(undefined);
    const result = await promotePlatformAdmin(h.repo, h.auditWriter, 'nobody@example.com', h.warn);
    expect(result).toEqual({ kind: 'not-registered' });
    expect(h.setRoleCalls).toEqual([]);
    expect(h.warnings.join(' ')).toMatch(/no registered user/);
  });

  it('is idempotent for an existing platform_admin (no duplicate audit)', async () => {
    const h = harness(makeUser({ role: 'platform_admin' }));
    const result = await promotePlatformAdmin(h.repo, h.auditWriter, 'admin@example.com', h.warn);
    expect(result).toEqual({ kind: 'already-admin', userId: 7 });
    expect(h.setRoleCalls).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});

describe('bootstrapPlatformAdmins', () => {
  it('is fail-closed with an empty list', async () => {
    const h = harness(makeUser());
    await bootstrapPlatformAdmins(h.repo, h.auditWriter, [], h.warn);
    expect(h.warnings.join(' ')).toMatch(/not configured/);
    expect(h.setRoleCalls).toEqual([]);
  });

  it('processes each listed email', async () => {
    const h = harness(makeUser());
    await bootstrapPlatformAdmins(h.repo, h.auditWriter, ['admin@example.com'], h.warn);
    expect(h.setRoleCalls).toEqual([[7, 'platform_admin']]);
  });
});