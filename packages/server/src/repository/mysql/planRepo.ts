import type { IPlanRepo } from '../interfaces.js';
import type { Plan } from '../../domain/entities.js';
import type { PlanCode } from '../../domain/enums.js';
import type { MysqlDb } from './db.js';

export class MysqlPlanRepo implements IPlanRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async findByCode(code: PlanCode): Promise<Plan | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plans WHERE code = ?', [code]);
    return rows[0] ? mapPlan(rows[0]) : undefined;
  }

  async listAll(): Promise<Plan[]> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plans ORDER BY price_month');
    return rows.map(mapPlan);
  }

  async seed(plans: Array<Omit<Plan, 'createTime' | 'updateTime'>>): Promise<void> {
    for (const p of plans) {
      await this.db().query(
        `INSERT INTO plans (code, name, price_month, price_year, max_devices, max_connections, sync_quota_bytes, sync_version_retention, history_retention_count, max_pats, features)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), price_month = VALUES(price_month), price_year = VALUES(price_year),
           max_devices = VALUES(max_devices), max_connections = VALUES(max_connections),
           sync_quota_bytes = VALUES(sync_quota_bytes), sync_version_retention = VALUES(sync_version_retention),
           history_retention_count = VALUES(history_retention_count), max_pats = VALUES(max_pats),
           features = VALUES(features)`,
        [p.code, p.name, p.priceMonth, p.priceYear, p.maxDevices, p.maxConnections, p.syncQuotaBytes, p.syncVersionRetention, p.historyRetentionCount, p.maxPats, p.features],
      );
    }
  }
}

function mapPlan(r: any): Plan {
  return {
    code: r.code as PlanCode,
    name: r.name,
    priceMonth: r.price_month,
    priceYear: r.price_year,
    maxDevices: r.max_devices,
    maxConnections: r.max_connections,
    syncQuotaBytes: r.sync_quota_bytes,
    syncVersionRetention: r.sync_version_retention,
    historyRetentionCount: r.history_retention_count,
    maxPats: r.max_pats,
    features: r.features,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}
