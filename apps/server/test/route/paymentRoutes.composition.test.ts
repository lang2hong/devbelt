import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerPaymentRoutes } from '../../src/modules/billing/route/paymentRoutes.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';
import type { OrdersRouteOptions } from '../../src/modules/billing/route/orders.js';
import type { PaymentCallbackRouteOptions } from '../../src/modules/billing/route/paymentCallback.js';

describe('payment routes fail-closed composition', () => {
  it('registers nothing when disabled → both endpoints 404 even in development', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);

    await registerPaymentRoutes(app, {
      enabled: false,
      orders: {} as OrdersRouteOptions,
      callback: {} as PaymentCallbackRouteOptions,
    });
    await app.ready();

    const create = await app.inject({ method: 'POST', url: '/api/db/console/orders', payload: {} });
    expect(create.statusCode).toBe(404);

    const callback = await app.inject({ method: 'POST', url: '/api/db/public/payment-callback/wechat', payload: {} });
    expect(callback.statusCode).toBe(404);

    await app.close();
  });
});