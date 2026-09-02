import type { IOrganizationPlanRepo } from '../interfaces.js';
import type { OrganizationPlan } from '../../domain/entities.js';
import type { OrganizationPlanStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 组织套餐仓储。当前只读，seed 由 migration 005 完成。 */
export class MysqlOrganizationPlanRepo implements IOrganizationPlanRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByCode(code: string): Promise<OrganizationPlan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organization_plans WHERE code = ?', [code]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async findById(id: number): Promise<OrganizationPlan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM organization_plans WHERE id = ?', [id]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async findByCodeForUpdate(exec: Queryable, code: string): Promise<OrganizationPlan | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM organization_plans WHERE code = ? FOR UPDATE', [code]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }
}

function mapPlan(r: any): OrganizationPlan {
  const allowed = typeof r.allowed_template_database_types === 'string' ? JSON.parse(r.allowed_template_database_types) : r.allowed_template_database_types;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    includedSeats: r.included_seats,
    maxSharedResources: r.max_shared_resources,
    sharedStorageQuotaBytes: Number(r.shared_storage_quota_bytes),
    allowedTemplateDatabaseTypes: Array.isArray(allowed) ? allowed : [],
    status: r.status as OrganizationPlanStatus,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
