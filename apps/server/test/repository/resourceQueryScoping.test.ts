import { describe, it, expect } from 'vitest';
import { MysqlFolderRepo } from '../../src/modules/organization/repository/folderRepo.js';
import { MysqlResourceRepo } from '../../src/modules/organization/repository/resourceRepo.js';
import type { MysqlDb } from '../../src/repository/mysql/db.js';

/**
 * 机械化验收项「查询均受 organizationId 约束」（§2 第 5 条）：folder / resource 仓储的
 * 每条查询（除 create 的 INSERT + 按刚插入主键回读外）都必须带 `organization_id`
 * 谓词，跨组织越界在 SQL 层即被限定，而非只靠服务层事后比对。
 */
function recordingDb() {
  const sqls: string[] = [];
  const query = async <T = any>(sql: string): Promise<T> => {
    sqls.push(sql);
    return [[], undefined] as unknown as T;
  };
  const fake: MysqlDb = {
    database: 'test',
    query,
    getConnection: async () => ({
      query,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    }),
  };
  return { sqls, fake };
}

const ORG = 1;

describe('folder/resource repo queries are organization-scoped', () => {
  it('every folder repo query contains organization_id', async () => {
    const { sqls, fake } = recordingDb();
    const repo = new MysqlFolderRepo(() => fake);
    await repo.findByIdForUpdate(fake, ORG, 1);
    await repo.listActive(ORG);
    await repo.countActiveChildren(fake, ORG, 1);
    await repo.countActiveResources(fake, ORG, 1);
    await repo.updateName(fake, 1, 'x', ORG);
    await repo.updateParent(fake, 1, null, ORG);
    await repo.softDelete(fake, 1, ORG, new Date());
    await repo.collectDescendantIds(fake, ORG, 1);
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) expect(sql).toContain('organization_id');
  });

  it('every resource repo query contains organization_id', async () => {
    const { sqls, fake } = recordingDb();
    const repo = new MysqlResourceRepo(() => fake);
    await repo.findById(ORG, 1);
    await repo.findByIdForUpdate(fake, ORG, 1);
    await repo.listActiveByOrganization(ORG);
    await repo.listActiveContent(fake, ORG);
    await repo.update(fake, { id: 1, organizationId: ORG, name: 'x', folderId: null, content: {}, baseVersion: 1, updatedByMembershipId: 1 });
    await repo.softDelete(fake, 1, ORG, new Date(), 1);
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) expect(sql).toContain('organization_id');
  });

  it('resource update SQL enforces the frozen version condition', async () => {
    const { sqls, fake } = recordingDb();
    const repo = new MysqlResourceRepo(() => fake);
    await repo.update(fake, { id: 1, organizationId: ORG, name: 'x', folderId: null, content: {}, baseVersion: 3, updatedByMembershipId: 1 });
    const updateSql = sqls.find((sql) => sql.startsWith('UPDATE organization_resources'));
    expect(updateSql).toContain('version = ?');
    expect(updateSql).toMatch(/WHERE\s+id = \?\s+AND\s+organization_id = \?\s+AND\s+version = \?\s+AND\s+delete_time IS NULL/);
  });
});