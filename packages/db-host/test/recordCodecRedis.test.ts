import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { databaseTypeFromEngine, decodeEntityPayload, encodeRecordPayload } from '../src/sync/e2e/recordCodec';
import type { SavedConnection } from '../src/connection/connectionStore';

/**
 * Redis 连接纳入同步（此前 P7 S1 曾 fail-closed 排除；现与 mysql/sqlite 同口径）。
 * 校验引擎识别、字段往返（含敏感字段仅入密文）、未知引擎仍 fail-closed。
 */
describe('recordCodec：Redis 连接可同步', () => {
  it('databaseTypeFromEngine 识别 redis；未知引擎仍 fail-closed', () => {
    expect(databaseTypeFromEngine('redis')).toBe(DatabaseType.REDIS);
    expect(databaseTypeFromEngine('mysql')).toBe(DatabaseType.MYSQL);
    expect(() => databaseTypeFromEngine('mongo')).toThrow(/unknown database engine/);
  });

  it('standalone 往返：host/port/redisDb/keySeparator/password/color', () => {
    const conn = {
      id: 'r1', name: 'redis', dbType: DatabaseType.REDIS, host: 'h', port: 6379,
      user: 'default', password: 'p', redisDb: 2, keySeparator: '-', color: '#fff',
    } as SavedConnection;
    const decoded = decodeEntityPayload(encodeRecordPayload(conn));
    expect(decoded.type).toBe('connection');
    const d = decoded.data as unknown as Record<string, unknown>;
    expect(d.dbType).toBe(DatabaseType.REDIS);
    expect(d.host).toBe('h');
    expect(d.port).toBe(6379);
    expect(d.user).toBe('default');
    expect(d.password).toBe('p');
    expect(d.redisDb).toBe(2);
    expect(d.keySeparator).toBe('-');
    expect(d.color).toBe('#fff');
  });

  it('sentinel / cluster 专属字段往返', () => {
    const sentinel = {
      id: 'r2', name: 'redis', dbType: DatabaseType.REDIS, host: 'h', port: 6379, user: '',
      redisMode: 'sentinel', sentinelName: 'mymaster', sentinelNodes: 'h:26379', sentinelPassword: 'sp',
    } as SavedConnection;
    const d = decodeEntityPayload(encodeRecordPayload(sentinel)).data as unknown as Record<string, unknown>;
    expect(d.redisMode).toBe('sentinel');
    expect(d.sentinelName).toBe('mymaster');
    expect(d.sentinelNodes).toBe('h:26379');
    expect(d.sentinelPassword).toBe('sp');

    const cluster = {
      id: 'r3', name: 'redis', dbType: DatabaseType.REDIS, host: 'h', port: 6379, user: '',
      redisMode: 'cluster', clusterNodes: 'h1:6379,h2:6379',
    } as SavedConnection;
    const c = decodeEntityPayload(encodeRecordPayload(cluster)).data as unknown as Record<string, unknown>;
    expect(c.redisMode).toBe('cluster');
    expect(c.clusterNodes).toBe('h1:6379,h2:6379');
  });

  it('未知字段被忽略（D14 向前兼容），不抛错', () => {
    expect(decodeEntityPayload({ type: 'connection', dbType: 'redis', name: 'r', host: 'h', port: 6379, bogus: 1 }))
      .toMatchObject({ type: 'connection' });
  });
});