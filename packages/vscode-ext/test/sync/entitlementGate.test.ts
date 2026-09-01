import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@db-client/core';
import {
  PersonalEntitlementDeniedError,
  assertPersonalDatabaseType,
  allowedEngines,
  databaseEngineOf,
  filterPersonalConnectionsByEntitlement,
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
  it('无权益返回 undefined（fail-open 不受限）', () => {
    expect(allowedEngines(undefined)).toBeUndefined();
    expect(allowedEngines(null)).toBeUndefined();
  });

  it('有权益直接返回缓存列表', () => {
    expect(allowedEngines(pro)).toEqual(['mysql', 'postgresql', 'sqlite']);
  });
});

describe('assertPersonalDatabaseType', () => {
  it('允许的引擎不抛', () => {
    expect(() => assertPersonalDatabaseType(DatabaseType.MYSQL, free)).not.toThrow();
  });

  it('无权益（未登录/登出）fail-open：postgresql 放行', () => {
    expect(() => assertPersonalDatabaseType(DatabaseType.PG, undefined)).not.toThrow();
    expect(() => assertPersonalDatabaseType(DatabaseType.PG, null)).not.toThrow();
  });

  it('有 free 权益时 postgresql 被拒且携带 engine', () => {
    const fn = () => assertPersonalDatabaseType(DatabaseType.PG, free);
    expect(fn).toThrowError(PersonalEntitlementDeniedError);
    try {
      fn();
    } catch (err) {
      expect((err as PersonalEntitlementDeniedError).engine).toBe('postgresql');
    }
  });

  it('有 pro 权益时 postgresql 放行', () => {
    expect(() => assertPersonalDatabaseType(DatabaseType.PG, pro)).not.toThrow();
  });
});

describe('filterPersonalConnectionsByEntitlement', () => {
  const c = (dbType: DatabaseType, name: string, deleted = false) => ({ dbType, name, deleted });

  it('有 free 权益：不勾选引擎逐条跳过并收集（name, engine）清单', () => {
    const input = [c(DatabaseType.MYSQL, 'a'), c(DatabaseType.PG, 'pg-one'), c(DatabaseType.PG, 'pg-two')];
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement(input, free);
    expect(allowed).toEqual([c(DatabaseType.MYSQL, 'a')]);
    expect(skipped).toEqual([
      { name: 'pg-one', engine: 'postgresql' },
      { name: 'pg-two', engine: 'postgresql' },
    ]);
  });

  it('无权益：fail-open 全部放行（含 postgresql）', () => {
    const input = [c(DatabaseType.MYSQL, 'a'), c(DatabaseType.PG, 'pg')];
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement(input, undefined);
    expect(allowed).toEqual(input);
    expect(skipped).toEqual([]);
  });

  it('删除墓碑永不门禁、原样保留', () => {
    const input = [c(DatabaseType.MYSQL, 'a'), c(DatabaseType.PG, 'pg-tombstone', true)];
    const { allowed, skipped } = filterPersonalConnectionsByEntitlement(input, free);
    expect(allowed).toEqual(input);
    expect(skipped).toEqual([]);
  });

  it('未知 dbType 保守拒绝并归入 skipped（与权益无关）', () => {
    const unknown = { dbType: 'MARIADB' as unknown as DatabaseType, name: 'x', deleted: false };
    const withFree = filterPersonalConnectionsByEntitlement([unknown], free);
    expect(withFree.allowed).toEqual([]);
    expect(withFree.skipped).toEqual([{ name: 'x', engine: 'MARIADB' }]);

    const noEntitlement = filterPersonalConnectionsByEntitlement([unknown], undefined);
    expect(noEntitlement.allowed).toEqual([]);
    expect(noEntitlement.skipped).toEqual([{ name: 'x', engine: 'MARIADB' }]);
  });
});