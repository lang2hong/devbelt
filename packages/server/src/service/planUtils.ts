import type { Plan } from '../domain/entities.js';

/** 取套餐数组中月费最高者为主套餐（用户展示用）。 */
export function pickPrimaryPlan(plans: Plan[]): Plan {
  if (plans.length === 0) throw new Error('no effective plan; registration should guarantee a personal org');
  return plans.reduce((a, b) => (b.priceMonth > a.priceMonth ? b : a));
}
