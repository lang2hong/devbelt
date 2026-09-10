import { describe, it, expect } from 'vitest';
import { resolvePaymentGateway, paymentGatewayConfigured, MemoryPaymentGateway, signMemoryCallback } from '../../src/service/paymentChannel.js';

describe('paymentChannel fail-closed', () => {
  it('is NOT configured in development (no real adapter yet)', async () => {
    expect(paymentGatewayConfigured({ NODE_ENV: 'development' })).toBe(false);
  });

  it('throws even in development when resolving a gateway', async () => {
    expect(() => resolvePaymentGateway('wechat', { NODE_ENV: 'development' })).toThrow(/not configured/);
  });

  it('throws in production and unspecified environments', async () => {
    expect(() => resolvePaymentGateway('wechat', { NODE_ENV: 'production' })).toThrow(/not configured/);
    expect(() => resolvePaymentGateway('alipay', {})).toThrow(/not configured/);
  });
});

describe('MemoryPaymentGateway (test-only)', () => {
  it('verifies a signature bound to the raw body', async () => {
    const g = new MemoryPaymentGateway('wechat');
    const raw = Buffer.from('{ "amountCents": 9900, "status": "success" }');
    expect(g.verifyCallback(raw, { 'x-payment-signature': signMemoryCallback(raw) })).toBe(true);
  });

  it('rejects when the body differs from what was signed', async () => {
    const g = new MemoryPaymentGateway('wechat');
    const raw = Buffer.from('{ "amountCents": 9900 }');
    const signature = signMemoryCallback(raw);
    expect(g.verifyCallback(Buffer.from('{ "amountCents": 9901 }'), { 'x-payment-signature': signature })).toBe(false);
    expect(g.verifyCallback(raw, { 'x-payment-signature': 'deadbeef' })).toBe(false);
  });
});