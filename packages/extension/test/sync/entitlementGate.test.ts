import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devkit/core';
import {
  DEFAULT_FREE_ENGINES,
  allowedEngines,
  databaseEngineOf,
  filterPersonalConnectionsByEntitlement,
  isOrganizationConnectionId,
  maxSavedConnections,
  canImportConnections,
  maxConcurrentConnections,
  canExportConnections,
  canUseErDiagram,
  canUseDataSync,
} from '../../src/sync/entitlementGate';

const free = { planCode: 'free', allowedDatabaseTypes: ['mysql', 'sqlite'], maxDevices: 2, maxSavedConnections: 10, allowConnectionImport: false };
const pro = { planCode: 'pro', allowedDatabaseTypes: ['mysql', 'postgresql', 'sqlite'], maxDevices: 5, maxSavedConnections: 100, allowConnectionImport: true };

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
describe('连接资产门禁 (maxSavedConnections / canImportConnections)', () => {
  it('无权益时 fail-closed：连接上限 10、禁止导入', () => {
    expect(maxSavedConnections(undefined)).toBe(10);
    expect(maxSavedConnections(null)).toBe(10);
    expect(canImportConnections(undefined)).toBe(false);
    expect(canImportConnections(null)).toBe(false);
  });

  it('free 档：10 条、禁止导入', () => {
    expect(maxSavedConnections(free)).toBe(10);
    expect(canImportConnections(free)).toBe(false);
  });

  it('pro 档：100 条、允许导入', () => {
    expect(maxSavedConnections(pro)).toBe(100);
    expect(canImportConnections(pro)).toBe(true);
  });

  it('0 视为不限，但 canImportConnections 只看布尔', () => {
    const unlimited = { ...free, maxSavedConnections: 0 };
    expect(maxSavedConnections(unlimited)).toBe(0);
    expect(canImportConnections(unlimited)).toBe(false);
  });

  it('缺 maxSavedConnections 字段回落到默认 10', () => {
    const missing = { planCode: 'x', allowedDatabaseTypes: [], maxDevices: 0 } as unknown as Parameters<typeof maxSavedConnections>[0];
    expect(maxSavedConnections(missing)).toBe(10);
  });
});

describe('并发/导出/ER/数据同步 门禁', () => {
  it('maxConcurrentConnections 缺省 0=不限，读取缓存值', () => {
    expect(maxConcurrentConnections(undefined)).toBe(0);
    expect(maxConcurrentConnections({ planCode: 'free', allowedDatabaseTypes: [], maxDevices: 0, maxSavedConnections: 10, allowConnectionImport: false, maxConcurrentConnections: 5 })).toBe(5);
  });

  it('导出/ER/数据同步：缺省允许，显式 false 才禁用', () => {
    expect(canExportConnections(undefined)).toBe(true);
    expect(canExportConnections({ planCode: 'free', allowedDatabaseTypes: [], maxDevices: 0, maxSavedConnections: 10, allowConnectionImport: false, allowConnectionExport: false })).toBe(false);
    expect(canUseErDiagram({ planCode: 'free', allowedDatabaseTypes: [], maxDevices: 0, maxSavedConnections: 10, allowConnectionImport: false, allowErDiagram: false })).toBe(false);
    expect(canUseDataSync({ planCode: 'free', allowedDatabaseTypes: [], maxDevices: 0, maxSavedConnections: 10, allowConnectionImport: false, allowDataSync: false })).toBe(false);
    expect(canUseErDiagram(undefined)).toBe(true);
    expect(canUseDataSync(undefined)).toBe(true);
  });
});
