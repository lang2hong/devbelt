/**
 * 套餐目录（/api/db/plans）：从库内 `plans` + 纵表特性组装对外 PlanDto。
 *
 * ## 动态特征描述符
 *
 * 特征以 `{ key, type, value, label }` 暴露；type 来自 `plan_feature_defs.value_type`，
 * 前端据此格式化，新增特征维度无需改接口形状。未知 key 优雅降级（无 label 时仅 key）。
 *
 * ## 数值语义
 *
 * 配额列以 `0` 表示**不限**，原样透出（消费方以 `if (limit > 0)` 判定）。价格来自
 * `plans.price_cents`；0 = 免费（个人）或待定价（组织，无自助下单路径）。
 */
import type { Plan, PlanFeatureDef } from '../../../domain/entities.js';
import type { IPlanRepo, IPlanFeatureDefRepo } from '../../../repository/interfaces.js';

/** 特征值类型：决定前端的格式化方式。 */
export type FeatureType = 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';

export interface FeatureDto {
  key: string;
  type: FeatureType;
  value: boolean | number | string | string[];
  label?: { en: string; zh: string };
}

export type BillingUnit = 'month' | 'seat-month';

export interface PlanDto {
  code: string;
  name: string;
  billing: {
    unit: BillingUnit;
    /** 单价（CNY 分）；0 表示免费/待定价。 */
    priceCents: number;
  };
  features: FeatureDto[];
}

export interface PlanCatalog {
  personal: PlanDto[];
  organization: PlanDto[];
}

export function planDto(plan: Plan, defs: Map<string, PlanFeatureDef>): PlanDto {
  const features: FeatureDto[] = [];
  const seen = new Set<string>();
  // 先按 defs 顺序（仅本 kind 适用的 def），再补 plan.features 里没有 def 的键（降级）。
  for (const def of [...defs.values()].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (def.kind !== 'both' && def.kind !== plan.kind) continue;
    if (!(def.key in plan.features)) continue;
    features.push({ key: def.key, type: def.valueType, value: plan.features[def.key] as FeatureDto['value'], label: def.label });
    seen.add(def.key);
  }
  for (const [key, value] of Object.entries(plan.features)) {
    if (seen.has(key)) continue;
    features.push({ key, type: inferType(value), value: value as FeatureDto['value'] });
  }
  return {
    code: plan.code,
    name: plan.name,
    billing: { unit: plan.billingUnit, priceCents: plan.priceCents },
    features,
  };
}

export async function buildPlanCatalog(planRepo: IPlanRepo, defRepo: IPlanFeatureDefRepo): Promise<PlanCatalog> {
  const [plans, defList] = await Promise.all([planRepo.listActive(), defRepo.listAll()]);
  const defs = new Map(defList.map((d) => [d.key, d]));
  return {
    personal: plans.filter((p) => p.kind === 'personal').map((p) => planDto(p, defs)),
    organization: plans.filter((p) => p.kind === 'organization').map((p) => planDto(p, defs)),
  };
}

function inferType(value: unknown): FeatureType {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'stringList';
  return 'enum';
}