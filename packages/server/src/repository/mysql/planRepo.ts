import type { IPlanRepo, IPlanFeatureDefRepo } from '../interfaces/plan.js';
import type { Plan, PlanFeatureDef } from '../../domain/entities.js';
import type { MysqlDb, Queryable } from './db.js';

/**
 * 套餐仓储（个人/组织统一）。
 *
 * 特性存于纵表 `plan_feature_values`（值）+ `plan_feature_defs`（类型/标签）。
 * 读取时按 def 的 `value_type` 强转为正确的 JS 类型后拼进 `Plan.features`：
 * - bool → boolean（绝不让字符串 "false" 变成真值）
 * - number/bytes → number
 * - stringList → array（含驱动以字符串返回 JSON 的兜底）
 * - enum → string
 * 缺特性即该键不存在（消费方按「缺特性 = deny」处理，0 原样保留为「不限」）。
 *
 * ## 进程内缓存（plans.version 失效）
 * 登录热路径与 /api/me 每请求都要解析 free 档与订阅 plan；每次两条查询成本高。
 * 这里按 id/code 缓存完整 Plan，写入（`saveInTx`）与任何读路径刷新时同步覆盖。
 * 单实例部署下等价权威；多实例时其它实例在下次编辑前可能读到旧值（当前部署为单实例）。
 */
export class MysqlPlanRepo implements IPlanRepo {
  private readonly byId = new Map<number, Plan>();
  private readonly byCode = new Map<string, Plan>();

  constructor(private readonly db: () => MysqlDb) {}

  async findByCode(code: string): Promise<Plan | undefined> {
    const cached = this.byCode.get(code);
    if (cached) return cached;
    const rows = await this.queryPlans('WHERE p.code = ?', [code]);
    return rows[0];
  }

  async findById(id: number): Promise<Plan | undefined> {
    const cached = this.byId.get(id);
    if (cached) return cached;
    const rows = await this.queryPlans('WHERE p.id = ?', [id]);
    return rows[0];
  }

  async findByCodeInTx(exec: Queryable, code: string): Promise<Plan | undefined> {
    const cached = this.byCode.get(code);
    if (cached) return cached;
    const rows = await this.queryPlans('WHERE p.code = ?', [code], exec);
    return rows[0];
  }

  async findByIdInTx(exec: Queryable, id: number): Promise<Plan | undefined> {
    const cached = this.byId.get(id);
    if (cached) return cached;
    const rows = await this.queryPlans('WHERE p.id = ?', [id], exec);
    return rows[0];
  }

  async listActive(): Promise<Plan[]> {
    return this.queryPlans('WHERE p.status = ? ORDER BY p.kind, p.sort_order, p.id', ['active']);
  }

  async listAll(): Promise<Plan[]> {
    return this.queryPlans('ORDER BY p.kind, p.sort_order, p.id', []);
  }

  /** 清除进程内缓存（管理端提交后调用）。 */
  invalidate(planId: number): void {
    const cached = this.byId.get(planId);
    if (cached) this.byCode.delete(cached.code);
    this.byId.delete(planId);
  }

  async saveInTx(
    exec: Queryable,
    input: {
      id: number; name: string; priceCents: number; billingUnit: Plan['billingUnit'];
      sortOrder: number; status: Plan['status'];
      features: ReadonlyArray<{ featureKey: string; value: unknown }>;
      expectedVersion: number;
    },
  ): Promise<boolean> {
    const [res] = await exec.query(
      `UPDATE plans
          SET name = ?, price_cents = ?, billing_unit = ?, sort_order = ?, status = ?, version = version + 1
        WHERE id = ? AND version = ?`,
      [input.name, input.priceCents, input.billingUnit, input.sortOrder, input.status, input.id, input.expectedVersion],
    );
    if ((res as { affectedRows: number }).affectedRows !== 1) return false;

    await exec.query('DELETE FROM plan_feature_values WHERE plan_id = ?', [input.id]);
    for (const { featureKey, value } of input.features) {
      const [inserted] = await exec.query(
        `INSERT INTO plan_feature_values (plan_id, feature_def_id, value_json)
         SELECT ?, d.id, ? FROM plan_feature_defs d WHERE d.feature_key = ?`,
        [input.id, JSON.stringify(value), featureKey],
      );
      // 未知 feature_key → 0 行：绝不静默丢特性。
      if ((inserted as { affectedRows: number }).affectedRows !== 1) {
        throw new Error(`unknown feature_key: ${featureKey}`);
      }
    }

    this.byId.delete(input.id);
    this.byCode.clear();
    return true;
  }

  private async queryPlans(where: string, params: unknown[], exec?: Queryable): Promise<Plan[]> {
    const q = exec ?? this.db();
    const [rows] = await q.query<any[]>(`SELECT p.* FROM plans p ${where}`, params);
    if (rows.length === 0) return [];
    const features = await this.loadFeatures(q, rows.map((r: any) => Number(r.id)));
    const plans = rows.map((r: any) => mapPlan(r, features.get(Number(r.id)) ?? {}));
    // 仅池级（已提交）读回填缓存；事务连接可能读到未提交值，写入共享缓存会在回滚后留幻影。
    if (exec === undefined) {
      for (const p of plans) {
        this.byId.set(p.id, p);
        this.byCode.set(p.code, p);
      }
    }
    return plans;
  }

  private async loadFeatures(exec: Queryable, planIds: number[]): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>();
    if (planIds.length === 0) return out;
    const [rows] = await exec.query<any[]>(
      `SELECT v.plan_id, d.feature_key, d.value_type, v.value_json
         FROM plan_feature_values v
         JOIN plan_feature_defs d ON d.id = v.feature_def_id
        WHERE v.plan_id IN (?)`,
      [planIds],
    );
    for (const r of rows) {
      const planId = Number(r.plan_id);
      const bucket = out.get(planId) ?? {};
      bucket[r.feature_key] = coerceFeature(r.value_json, r.value_type);
      out.set(planId, bucket);
    }
    return out;
  }
}

/** 套餐特性定义仓储。 */
export class MysqlPlanFeatureDefRepo implements IPlanFeatureDefRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async listAll(): Promise<PlanFeatureDef[]> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plan_feature_defs ORDER BY sort_order, kind, id');
    return rows.map(mapDef);
  }

  async findByKey(key: string): Promise<PlanFeatureDef | undefined> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM plan_feature_defs WHERE feature_key = ?', [key]);
    return rows[0] ? mapDef(rows[0]) : undefined;
  }

  async findByKeyInTx(exec: Queryable, key: string): Promise<PlanFeatureDef | undefined> {
    const [rows] = await exec.query<any[]>('SELECT * FROM plan_feature_defs WHERE feature_key = ?', [key]);
    return rows[0] ? mapDef(rows[0]) : undefined;
  }

  async upsertInTx(
    exec: Queryable,
    input: {
      key: string; kind: PlanFeatureDef['kind']; label: PlanFeatureDef['label'];
      valueType: PlanFeatureDef['valueType']; unit: string | null; sortOrder: number;
    },
  ): Promise<void> {
    await exec.query(
      `INSERT INTO plan_feature_defs (feature_key, kind, label_json, value_type, unit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), label_json = VALUES(label_json),
         value_type = VALUES(value_type), unit = VALUES(unit), sort_order = VALUES(sort_order)`,
      [input.key, input.kind, JSON.stringify(input.label), input.valueType, input.unit, input.sortOrder],
    );
  }
}

function coerceFeature(value: unknown, valueType: string): unknown {
  if (valueType === 'bool') return value === true || value === 1 || value === '1' || value === 'true';
  if (valueType === 'number' || valueType === 'bytes') return typeof value === 'number' ? value : Number(value);
  if (valueType === 'stringList') {
    if (Array.isArray(value)) return value;
    // 对称兜底：驱动若以字符串返回 JSON 列（如开启 jsonStrings），仍解析而非静默归 []。
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
  return String(value);
}

function mapPlan(r: any, features: Record<string, unknown>): Plan {
  return {
    id: Number(r.id),
    code: r.code,
    kind: r.kind,
    name: r.name,
    priceCents: Number(r.price_cents),
    billingUnit: r.billing_unit,
    sortOrder: Number(r.sort_order),
    status: r.status,
    version: Number(r.version),
    features,
    createTime: new Date(r.create_time),
    updateTime: new Date(r.update_time),
  };
}

function mapDef(r: any): PlanFeatureDef {
  const label = typeof r.label_json === 'string' ? JSON.parse(r.label_json) : r.label_json;
  return {
    id: Number(r.id),
    key: r.feature_key,
    kind: r.kind,
    label: { en: label?.en ?? r.feature_key, zh: label?.zh ?? r.feature_key },
    valueType: r.value_type,
    unit: r.unit ?? null,
    sortOrder: Number(r.sort_order),
  };
}