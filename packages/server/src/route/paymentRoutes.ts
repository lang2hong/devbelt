import type { FastifyInstance } from 'fastify';
import { ordersReadRoutes, ordersWriteRoutes, type OrdersRouteOptions } from './orders.js';
import { paymentCallbackRoutes, type PaymentCallbackRouteOptions } from './paymentCallback.js';

/**
 * 支付路由的组合入口（P4）。
 *
 * - **只读订单路由恒注册**：列表/详情无资金面风险（切片 3 起对控制台可见）。
 * - **下单 + 公开回调仅在真网关已配置时注册**：否则完全不注册（落到 404），即使
 *   进程环境是 development，未显式提供真实 gateway 时也不暴露可伪造的支付面（P0）。
 */
export interface PaymentRoutesOptions {
  enabled: boolean;
  orders: OrdersRouteOptions;
  callback: PaymentCallbackRouteOptions;
}

export async function registerPaymentRoutes(app: FastifyInstance, opts: PaymentRoutesOptions): Promise<void> {
  await app.register(ordersReadRoutes, opts.orders);
  if (!opts.enabled) return;
  await app.register(ordersWriteRoutes, opts.orders);
  await app.register(paymentCallbackRoutes, opts.callback);
}