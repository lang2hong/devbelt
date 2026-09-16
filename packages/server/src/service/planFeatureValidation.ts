import type { PlanFeatureDef } from '../domain/entities.js';
import { ValidationError } from '../domain/errors.js';

/**
 * 套餐特性取值校验（管理端写入侧）：按 `plan_feature_defs.value_type` 强制类型与范围。
 *
 * 关键：`0 = 不限` 的语义让「损坏数值」（NaN/负数/非整）变成危险值——NaN 与任何比较
 * 都为 false，配额层会当作「不限」放行。因此这里对 number/bytes 要求**有限整数且 >= 0**；
 * bool/stringList/enum 亦严格校验，绝不接受 `"false"` 这类字符串布尔。
 */
export function validateFeatureValue(def: PlanFeatureDef, value: unknown): void {
  switch (def.valueType) {
    case 'bool':
      if (typeof value !== 'boolean') throw new ValidationError(`feature ${def.key} expects boolean`);
      return;
    case 'number':
    case 'bytes':
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new ValidationError(`feature ${def.key} expects a non-negative integer`);
      }
      return;
    case 'stringList':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
        throw new ValidationError(`feature ${def.key} expects an array of non-empty strings`);
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || value.length === 0) {
        throw new ValidationError(`feature ${def.key} expects a non-empty string`);
      }
      return;
    default:
      throw new ValidationError(`feature ${def.key} has an unsupported value type`);
  }
}

/** 兜底档：不可归档（否则 requireFree 会让全站权益读路径 500）。 */
export const FREE_PLAN_CODES: ReadonlySet<string> = new Set(['free', 'organization_free']);