import type { FastifyInstance } from 'fastify';
import { ordersRoutes, type OrdersRouteOptions } from './orders.js';
import { paymentCallbackRoutes, type PaymentCallbackRouteOptions } from './paymentCallback.js';

/**
 * 支付路由的组合入口（P4 切片 2）。
 *
 * 仅在真网关已配置时注册订单 + 公开回调路由；否则**完全不注册**（请求落到 404）。
 * 抽出成独立模块，使组合级 fail-closed 行为可被直接断言：即使进程环境是
 * development，未显式提供真实 gateway 时两个支付端点都必须 404（P0）。
 */
export interface PaymentRoutesOptions {
  enabled: boolean;
  orders: OrdersRouteOptions;
  callback: PaymentCallbackRouteOptions;
}

export async function registerPaymentRoutes(app: FastifyInstance, opts: PaymentRoutesOptions): Promise<void> {
  if (!opts.enabled) return;
  await app.register(ordersRoutes, opts.orders);
  await app.register(paymentCallbackRoutes, opts.callback);
}