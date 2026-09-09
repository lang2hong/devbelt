import type { IPersonalPlanRepo } from '../interfaces.js';
import type { PersonalPlan } from '../../domain/entities.js';
import type { PersonalPlanStatus } from '../../domain/enums.js';
import type { MysqlDb, Queryable } from './db.js';

/** 个人套餐仓储。当前只读，seed 由 migration 002 完成。 */
export class MysqlPersonalPlanRepo implements IPersonalPlanRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByCode(code: string): Promise<PersonalPlan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM personal_plans WHERE code = ?', [code]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async findById(id: number): Promise<PersonalPlan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM personal_plans WHERE id = ?', [id]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async findByCodeInTx(exec: Queryable, code: string): Promise<PersonalPlan | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM personal_plans WHERE code = ?', [code]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }
}

function mapPlan(r: any): PersonalPlan {
  const allowed = typeof r.allowed_database_types === 'string' ? JSON.parse(r.allowed_database_types) : r.allowed_database_types;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    allowedDatabaseTypes: Array.isArray(allowed) ? allowed : [],
    maxDevices: r.max_devices,
    maxConnectionMetas: Number(r.max_connection_metas ?? 0),
    syncStorageBytes: Number(r.sync_storage_bytes ?? 0),
    maxSavedConnections: Number(r.max_saved_connections ?? 0),
    allowConnectionImport: r.allow_connection_import === 1 || r.allow_connection_import === true,
    status: r.status as PersonalPlanStatus,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
