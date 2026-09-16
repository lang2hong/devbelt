/**
 * 套餐目录（/api/plans）：把 personal_plans / organization_plans 上架档位映射为
 * 对外的 PlanDto 列表。
 *
 * ## 动态特征描述符
 *
 * 特征不做固定字段暴露，而是 `features: FeatureDto[]`（key/type/value）。前端按 key
 * 渲染标签与格式，**新增特征维度不需要改接口形状**；未知 key 优雅降级（显示原始值）。
 * `type` 供前端选择格式（bytes → MiB、bool → 是/否、stringList → 标签列表）。
 *
 * ## 数值语义
 *
 * 配额列以 `0` 表示**不限**，原样透出，由前端文案表达（不要在服务端折算成别的东西，
 * 否则会丢掉「0=不限」这一约定）。引擎白名单（allowedDatabaseTypes）是动态字符串
 * 列表：新增 es/redis/sls 只是值变化；**能否真正解锁**另由客户端引擎门禁决定。
 */
import type { OrganizationPlan, PersonalPlan } from '../domain/entities.js';
import type { IPersonalPlanRepo, IOrganizationPlanRepo } from '../repository/interfaces.js';
import { organizationSeatPriceCents, planPriceCents } from './pricing.js';

/** 特征值类型：决定前端的格式化方式。 */
export type FeatureType = 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';

export interface FeatureDto {
  key: string;
  type: FeatureType;
  value: boolean | number | string | string[];
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

export function personalPlanDto(plan: PersonalPlan): PlanDto {
  return {
    code: plan.code,
    name: plan.name,
    billing: { unit: 'month', priceCents: planPriceCents(plan.code) },
    features: [
      { key: 'allowedDatabaseTypes', type: 'stringList', value: plan.allowedDatabaseTypes },
      { key: 'maxSavedConnections', type: 'number', value: plan.maxSavedConnections },
      { key: 'maxConnectionMetas', type: 'number', value: plan.maxConnectionMetas },
      { key: 'syncStorageBytes', type: 'bytes', value: plan.syncStorageBytes },
      { key: 'allowConnectionImport', type: 'bool', value: plan.allowConnectionImport },
      { key: 'maxDevices', type: 'number', value: plan.maxDevices },
    ],
  };
}

export function organizationPlanDto(plan: OrganizationPlan): PlanDto {
  return {
    code: plan.code,
    name: plan.name,
    billing: { unit: 'seat-month', priceCents: organizationSeatPriceCents(plan.code) },
    features: [
      { key: 'includedSeats', type: 'number', value: plan.includedSeats },
      { key: 'maxSharedResources', type: 'number', value: plan.maxSharedResources },
      { key: 'sharedStorageQuotaBytes', type: 'bytes', value: plan.sharedStorageQuotaBytes },
      { key: 'allowedTemplateDatabaseTypes', type: 'stringList', value: plan.allowedTemplateDatabaseTypes },
    ],
  };
}

/** 拉取上架档位并组装目录（个人 + 组织）。 */
export async function buildPlanCatalog(
  personalPlanRepo: IPersonalPlanRepo,
  organizationPlanRepo: IOrganizationPlanRepo,
): Promise<PlanCatalog> {
  const [personal, organization] = await Promise.all([
    personalPlanRepo.listActive(),
    organizationPlanRepo.listActive(),
  ]);
  return {
    personal: personal.map(personalPlanDto),
    organization: organization.map(organizationPlanDto),
  };
}