import { describe, expect, it } from 'vitest';
import { MysqlTelemetryRepo } from '../../src/modules/telemetry/repository/telemetryRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

type Row = Record<string, unknown>;

function makeDb(handler: (sql: string) => Row[]): { db: () => MysqlDb; queries: string[] } {
  const queries: string[] = [];
  const db = {
    database: 'test',
    query: async (sql: string) => {
      queries.push(sql);
      return [handler(sql), undefined];
    },
    getConnection: async () => { throw new Error('unused'); },
  } as unknown as MysqlDb;
  return { db: () => db, queries };
}

describe('MysqlTelemetryRepo.record', () => {
  it('写安装行后按 UTC 日期写活跃行（INSERT IGNORE 去重）', async () => {
    const { db, queries } = makeDb(() => []);
    await new MysqlTelemetryRepo(db).record({
      installId: '123e4567-e89b-42d3-a456-426614174000',
      appVersion: '0.4.1',
      os: 'linux',
      arch: 'x64',
      isRemote: false,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('INSERT INTO extension_installs');
    expect(queries[1]).toContain('INSERT IGNORE INTO extension_active_days');
    expect(queries[1]).toContain('UTC_DATE()');
  });
});

describe('MysqlTelemetryRepo.overview daily', () => {
  it('返回 30 个 UTC 日期点，缺失日期补 0', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

    const { db } = makeDb((sql) => {
      if (sql.includes('COUNT(*) AS total')) {
        return [{ total: 10, new7d: 4, new30d: 8, active24h: 3, active7d: 6, active30d: 9 }];
      }
      if (sql.includes('DATE(first_seen) AS day')) {
        return [{ day: today, n: '3' }, { day: twoDaysAgo, n: 2 }];
      }
      if (sql.includes('FROM extension_active_days')) {
        return [{ day: today, n: '1' }];
      }
      return [];
    });

    const o = await new MysqlTelemetryRepo(db).overview();
    expect(o.totalInstalls).toBe(10);
    expect(o.active30d).toBe(9);
    expect(o.daily).toHaveLength(30);
    expect(o.daily[29]).toEqual({ day: today, newInstalls: 3, activeInstalls: 1 });
    expect(o.daily[27]).toEqual({ day: twoDaysAgo, newInstalls: 2, activeInstalls: 0 });
    // 中间没有上报的日期补 0，且日期连续。
    expect(o.daily[28]).toEqual({ day: o.daily[28]!.day, newInstalls: 0, activeInstalls: 0 });
    for (let i = 1; i < o.daily.length; i++) {
      const prev = Date.parse(`${o.daily[i - 1]!.day}T00:00:00Z`);
      const cur = Date.parse(`${o.daily[i]!.day}T00:00:00Z`);
      expect(cur - prev).toBe(86_400_000);
    }
  });

  it('空表时 30 个点全为 0', async () => {
    const { db } = makeDb(() => []);
    const o = await new MysqlTelemetryRepo(db).overview();
    expect(o.totalInstalls).toBe(0);
    expect(o.daily).toHaveLength(30);
    expect(o.daily.every((p) => p.newInstalls === 0 && p.activeInstalls === 0)).toBe(true);
  });
});