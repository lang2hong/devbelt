import { describe, expect, it } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import { databaseTypeFromEngine, encodeRecordPayload } from '../src/sync/e2e/recordCodec';
import type { SavedConnection } from '../src/connection/connectionStore';

/**
 * P7 S1：Redis 连接必须 fail-closed 地排除在同步之外。
 * 注意实际拒绝点在 `databaseTypeFromEngine`（ENGINE_TO_DB_TYPE 尚无 'redis'），
 * `decodeConnectionPayload` 里的显式 REDIS 判断是未来 'redis' 入表后的防线。
 */
describe('recordCodec：Redis 连接 fail-closed（P7 S1）', () => {
  it('databaseTypeFromEngine 拒绝 redis（decode 侧实际生效的拒绝点）', () => {
    expect(() => databaseTypeFromEngine('redis')).toThrow(/unknown database engine/);
    expect(databaseTypeFromEngine('mysql')).toBe(DatabaseType.MYSQL);
  });

  it('encodeRecordPayload 对 REDIS 连接抛错（databaseEngineOf fail-closed）', () => {
    const conn = {
      id: 'r-1', name: 'redis', dbType: DatabaseType.REDIS, host: 'h', port: 6379, user: '',
    } as SavedConnection;
    expect(() => encodeRecordPayload(conn)).toThrow(/unknown DatabaseType/);
  });
});
