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
  /** 清除某套餐的进程内缓存（管理端提交后调用，闭合「提交前失效」竞态窗口）。 */
  invalidate(planId: number): void;
  /**
   * 管理端保存（元数据 + 特性整组替换，同一 CAS）：`WHERE id=? AND version=expectedVersion`，
   * 命中则写入并 `version+1`（一次性），返回是否命中。特性键不存在即抛错（不静默丢特性）。
   */
  saveInTx(exec: Queryable, input: {
    id: number; name: string; priceCents: number; billingUnit: Plan['billingUnit'];
    sortOrder: number; status: Plan['status'];
    features: ReadonlyArray<{ featureKey: string; value: unknown }>;
    expectedVersion: number;
  }): Promise<boolean>;
}

/** 套餐特性定义目录。 */
export interface IPlanFeatureDefRepo {
  listAll(): Promise<PlanFeatureDef[]>;
  findByKey(key: string): Promise<PlanFeatureDef | undefined>;
  /** 事务内按 key 读（写事务内回读必须走同一连接，池读看不到未提交行）。 */
  findByKeyInTx(exec: Queryable, key: string): Promise<PlanFeatureDef | undefined>;
  /**
   * 新增/更新特性定义。**无乐观锁**（`ON DUPLICATE KEY UPDATE`，并发同 key 编辑
   * last-write-wins）——元数据可接受，变更由审计留痕；如需并发保护再加 version。
   */
  upsertInTx(exec: Queryable, input: {
    key: string; kind: PlanFeatureDef['kind']; label: PlanFeatureDef['label'];
    valueType: PlanFeatureDef['valueType']; unit: string | null; sortOrder: number;
  }): Promise<void>;
}