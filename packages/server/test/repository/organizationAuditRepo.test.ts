import { describe, expect, it } from 'vitest';
import { MysqlOrganizationAuditRepo } from '../../src/repository/mysql/organizationAuditRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

/** 见 organizationRepo.test.ts 的桩设计说明。 */
class StubDb {
  readonly database = 'stub';
  calls: Array<{ sql: string; params?: any[] }> = [];
  private selects: Array<{ marker: string; rows: any[] }> = [];

  reply(marker: string, rows: any[]): this {
    this.selects.push({ marker, rows });
    return this;
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T> {
    this.calls.push({ sql, params });
    for (const { marker, rows } of this.selects) {
      if (sql.includes(marker)) return [rows, []] as unknown as T;
    }
    return [{ affectedRows: 1 }, []] as unknown as T;
  }
  async getConnection() {
    throw new Error('not used');
  }
}

function repo(db: StubDb) {
  return new MysqlOrganizationAuditRepo(() => db as unknown as MysqlDb);
}

describe('MysqlOrganizationAuditRepo', () => {
  it('record 把 detail 序列化为 JSON 文本，null 字段归一', async () => {
    const db = new StubDb();
    await repo(db).record({
      organizationId: 1,
      actorUserId: 7,
      action: 'resource.update',
      resourceType: 'query',
      resourceId: 3,
      detail: { from: 'a', to: 'b' },
      ip: '10.0.0.1',
    });
    expect(db.calls[0].sql).toContain('INSERT INTO organization_audit_log');
    expect(db.calls[0].params).toEqual([1, 7, 'resource.update', 'query', 3, '{"from":"a","to":"b"}', '10.0.0.1']);
  });

  it('record 允许 actor/resource/detail 全 null', async () => {
    const db = new StubDb();
    await repo(db).record({ organizationId: 1, action: 'org.create' });
    expect(db.calls[0].params).toEqual([1, null, 'org.create', null, null, null, null]);
  });

  it('listByOrganization 按 id DESC 分页', async () => {
    const db = new StubDb().reply('organization_id = ?', [
      { id: 2, organization_id: 1, actor_user_id: 7, action: 'a', resource_type: null, resource_id: null, detail: '{"k":1}', ip: null, create_time: '2026-01-01' },
    ]);
    const rows = await repo(db).listByOrganization(1, 50, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toEqual({ k: 1 });
    expect(db.calls[0].sql).toContain('ORDER BY id DESC');
  });

  it('countByOrganization 数某组织全部留痕', async () => {
    const db = new StubDb().reply('COUNT', [{ cnt: 5 }]);
    const n = await repo(db).countByOrganization(1);
    expect(n).toBe(5);
    expect(db.calls[0].params).toEqual([1]);
  });
});
