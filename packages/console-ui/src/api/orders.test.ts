import { describe, expect, it } from 'vitest';
import { createOrder } from './orders';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createOrder', () => {
  it('posts planCode/channel with CSRF and returns order + payParams', async () => {
    const payload = {
      order: { orderNo: 'o1', planCode: 'pro', amountCents: 9900, channel: 'wechat', status: 'pending', paidTime: null, expiresTime: '2026-01-01T00:00:00.000Z', createTime: '2026-01-01T00:00:00.000Z' },
      payParams: { codeUrl: 'weixin://wxpay/pay?pr=x' },
    };
    let captured: { method?: string; body?: string; headers?: Record<string, string> } = {};
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      captured = { method: init?.method, body: init?.body as string, headers: init?.headers as Record<string, string> };
      return jsonResponse(201, payload);
    };

    const r = await createOrder('pro', 'wechat', 'csrf-tok', 'access', fetchImpl);
    expect(r).toEqual({ kind: 'ok', value: payload });
    expect(captured.method).toBe('POST');
    expect(JSON.parse(captured.body!)).toEqual({ planCode: 'pro', channel: 'wechat' });
    expect(captured.headers?.['X-CSRF-Token']).toBe('csrf-tok');
  });

  it('returns unauthorized without a token', async () => {
    const r = await createOrder('pro', 'alipay', 'csrf-tok', null, (() => { throw new Error('unreachable'); }) as never);
    expect(r).toEqual({ kind: 'unauthorized' });
  });

  it('surfaces terminal 503 as failure (feature disabled / channel unconfigured)', async () => {
    const fetchImpl = async () => jsonResponse(503, { error: { code: 'FEATURE_TEMPORARILY_DISABLED' } });
    const r = await createOrder('pro', 'alipay', 'csrf-tok', 'access', fetchImpl);
    expect(r).toEqual({ kind: 'failure' });
  });
});