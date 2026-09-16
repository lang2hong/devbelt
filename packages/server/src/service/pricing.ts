/**
 * 支付定价（P4 §金额与安全）：金额一律 CNY 分，服务端按 plan_code 计算，
 * 绝不接受前端传入金额；全程用整数（分）避免浮点精度错误。
 *
 * ## 占位价
 * 以下价格为**上线前占位**，正式商户号/费率确定后由运营调整（改本表即可，
 * 历史订单金额不受影响 —— 订单落库时已冻结 amount_cents）。org 套餐按 seat 计费，
 * 见 P4 §不在范围；此处只登记个人 pro 档位单价。
 */
import { UnknownPlanError } from '../domain/errors.js';

/** 可对外售卖的套餐单价（CNY 分）。 */
const PLAN_PRICE_CENTS: Readonly<Record<string, number>> = {
  pro: 9900, // ¥99/月（占位，上线前调整）
};

/** 免费档：0 元，不应产生订单。 */
const FREE_PLAN_CODES: ReadonlySet<string> = new Set(['free']);

/** 按 plan_code 取单价（分）。免费/未知套餐抛错 —— 免费无需下单。 */
export function resolvePriceCents(planCode: string): number {
  if (FREE_PLAN_CODES.has(planCode) || planCode === '') {
    throw new UnknownPlanError();
  }
  const cents = PLAN_PRICE_CENTS[planCode];
  if (cents === undefined) throw new UnknownPlanError();
  return cents;
}

/** 目录展示用：返回套餐月单价（分）；免费/未知 → 0（不抛错，仅展示）。 */
export function planPriceCents(planCode: string): number {
  return PLAN_PRICE_CENTS[planCode] ?? 0;
}

/**
 * 组织档位席位单价（CNY 分）。**占位**：组织套餐当前由运营改订阅，无自助支付，
 * 正式费率确定后在此登记；目录接口据此展示。
 */
const ORGANIZATION_SEAT_PRICE_CENTS: Readonly<Record<string, number>> = {};

/** 目录展示用：组织档位席位单价（分）；未知 → 0（待运营定价）。 */
export function organizationSeatPriceCents(planCode: string): number {
  return ORGANIZATION_SEAT_PRICE_CENTS[planCode] ?? 0;
}