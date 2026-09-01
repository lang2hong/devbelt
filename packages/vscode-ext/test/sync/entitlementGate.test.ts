import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import {
  DEFAULT_FREE_ENGINES,
  PersonalEntitlementDeniedError,
  assertPersonalDatabaseType,
  allowedEngines,
  databaseEngineOf,
  filterPersonalConnectionsByEntitlement,
  isOrganizationConnectionId,
} from '../../src/sync/entitlementGate';

const free = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2 };
const pro = { planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5 };

describe('databaseEngineOf', () => {
  it('三值映射正确', () => {
    expect(databaseEngineOf(DatabaseType.MYSQL)).toBe('mysql');
    expect(databaseEngineOf(DatabaseType.PG)).toBe('postgresql');
    expect(databaseEngineOf(DatabaseType.SQLITE)).toBe('sqlite');
  });

  it('未知 DatabaseType 抛错（fail-closed）', () => {
    expect(() => databaseEngineOf('MARIADB' as unknown as DatabaseType)).toThrowError(/unknown DatabaseType/);
  });
});

describe('allowedEngines', () => {
  it('无权益时 fail-closed 到默认 Free', () => {
    expect(allowedEngines(undefined)).toEqual(DEFAULT_FREE_ENGINES);
    expect(allowedEngines(null)).toEqual(DEFAULT_FREE_ENGINES);
  });

  it('有权益时直接用缓存值', () => {
    expect(allowedEngines(pro)).toEqual(['mysql', 'postgresql', 'sqlite']);
  });
});

describe('assertPersonalDatabaseType', () => {
  it('允许的引擎不抛', () => {
    expect(() => assertPersonalDatabaseType(DatabaseType.MYSQL, free)).not.toThrow();
    expect(() => assertPersonalDatabaseType(DatabaseType.SQLITE, undefined)).not.toThrow();
  });

  it('拒绝的引擎抛 PersonalEntitlementDeniedError 且携带 engine', () => {
    const fn = () => assertPersonalDatabaseType(DatabaseType.PG, free);
    expect(fn).toThrowError(PersonalEntitlementDeniedError);
    try {
      fn();
    } catch (err) {
      expect((err as PersonalEntitlementDeniedError).engine).toBe('postgresql');
    }
  });

  it('无权益（未登录）默认 Free：postgresql 被拒', () => {
    expect(() => assertPersonalDatabaseType(DatabaseType.PG, undefined)).toThrowError(PersonalEntitlementDeniedError);
    expect(() => assertPersonalDatabaseType(DatabaseType.PG, null)).toThrowError(PersonalEntitlementDeniedError);
  });

  it('有 pro 权益时 postgresql 放行', () => {
    expect(() => assertPersonalDatabaseType(DatabaseType.PG, pro)).not.toThrow();
  });
});

describe('isOrganizationConnectionId', () => {
  it('组织连接 org: 前缀识别为 true', () => {
    expect(isOrganizationConnectionId('org:1:2')).toBe(true);
    expect(isOrganizationConnectionId('org:abc')).toBe(true);
  });

  it('个人连接 id 与空值识别为 false', () => {
    expect(isOrganizationConnectionId('c-1-2')).toBe(false);
    expect(isOrganizationConnectionId(undefined)).toBe(false);
    expect(isOrganizationConnectionId('')).toBe(false);
  });
});

describe('filterPersonalConnectionsByEntitlement', () => {
  const c = (dbType: DatabaseType, name: string, deleted = false) => ({ dbType, name, deleted });

  it('全允许时 allowed 全保留、skipped 空', () => {
    const input = [c(DatabaseType.MYSQL, 'a'), c(DatabaseType.SQLITE, 'b')];
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement(input, free);
    expect(allowed).toEqual(input);
    expect(skipped).toEqual([]);
  });

  it('不勾选的引擎逐条跳过并收集（name, engine）清单', () => {
    const input = [c(DatabaseType.MYSQL, 'a'), c(DatabaseType.PG, 'pg-one'), c(DatabaseType.PG, 'pg-two')];
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement(input, free);
    expect(allowed).toEqual([c(DatabaseType.MYSQL, 'a')]);
    expect(skipped).toEqual([
      { name: 'pg-one', engine: 'postgresql' },
      { name: 'pg-two', engine: 'postgresql' },
    ]);
  });

  it('删除墓碑永不门禁、原样保留', () => {
    const input = [c(DatabaseType.MYSQL, 'a'), c(DatabaseType.PG, 'pg-tombstone', true)];
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement(input, free);
    expect(allowed).toEqual(input);
    expect(skipped).toEqual([]);
  });

  it('未知 dbType 保守拒绝并归入 skipped', () => {
    const unknown = { dbType: 'MARIADB' as unknown as DatabaseType, name: 'x', deleted: false };
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement([unknown], free);
    expect(allowed).toEqual([]);
    expect(skipped).toEqual([{ name: 'x', engine: 'MARIADB' }]);
  });
});