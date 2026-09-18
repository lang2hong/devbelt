import { describe, expect, it } from 'vitest';
import { configurePgTemporalParsers } from '../../src/connection/postgreSqlConnection';

describe('PostgreSQL 时间类型解析', () => {
  it('为 DATE/TIME/TIMESTAMP/TIMESTAMPTZ/TIMETZ 注册原样返回的解析器', () => {
    const registered = new Map<number, (v: string) => string>();
    configurePgTemporalParsers({ setTypeParser: (oid, fn) => { registered.set(oid, fn); } });

    for (const oid of [1082, 1083, 1114, 1184, 1266]) {
      expect(registered.has(oid)).toBe(true);
      expect(registered.get(oid)!('2024-01-14 16:00:00.123+08')).toBe('2024-01-14 16:00:00.123+08');
    }
  });
});