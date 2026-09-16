import type { Plan, PlanFeatureDef } from '../../domain/entities.js';
import type { Queryable } from '../mysql/db.js';

/** 套餐仓储（个人/组织统一）。特性通过纵表派生到 Plan.features。 */
export interface IPlanRepo {
  findByCode(code: string): Promise<Plan | undefined>;
  findById(id: number): Promise<Plan | undefined>;
  /** 事务内按 code 读（下单/换档在事务内解析套餐）。 */
  findByCodeInTx(exec: Queryable, code: string): Promise<Plan | undefined>;
  /** 事务内按 id 读（锁内派生权益）。 */
  findByIdInTx(exec: Queryable, id: number): Promise<Plan | undefined>;
  /** 上架套餐目录。 */
  listActive(): Promise<Plan[]>;
  /** 全部套餐（管理端，含 archived）。 */
  listAll(): Promise<Plan[]>;
  /** 管理端保存特性：整组事务替换（delete + insert），并自增 version。 */
  replaceFeaturesInTx(exec: Queryable, planId: number, values: ReadonlyArray<{ featureKey: string; value: unknown }>): Promise<void>;
  /** 管理端更新套餐元数据（name/price/status/sort），version 乐观锁。 */
  updateMetaInTx(exec: Queryable, input: {
    id: number; name: string; priceCents: number; billingUnit: Plan['billingUnit'];
    sortOrder: number; status: Plan['status']; expectedVersion: number;
  }): Promise<boolean>;
}

/** 套餐特性定义目录。 */
export interface IPlanFeatureDefRepo {
  listAll(): Promise<PlanFeatureDef[]>;
  findByKey(key: string): Promise<PlanFeatureDef | undefined>;
  upsertInTx(exec: Queryable, input: {
    key: string; kind: PlanFeatureDef['kind']; label: PlanFeatureDef['label'];
    valueType: PlanFeatureDef['valueType']; unit: string | null; sortOrder: number;
  }): Promise<void>;
}