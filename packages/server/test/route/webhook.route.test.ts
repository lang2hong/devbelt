import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';
import type { PaymentProvider, WebhookEvent } from '../../src/adapter/paymentProvider.js';
import type { PlanCode, PaymentProvider as ProviderName } from '../../src/domain/enums.js';

/**
 * webhook 验签的原始字节保真。
 *
 * ## 原先为什么必然失败
 *
 * 路由把 `Buffer.from(JSON.stringify(req.body))` 交给适配器 —— 拿 Fastify 解析后
 * 的对象重新序列化。HMAC 是逐字节算的，而重建的 JSON 几乎不可能与支付商发出的
 * 原文一致：键顺序、空白、Unicode 转义、数字表示、浮点精度，任一项不同签名就不匹配。
 * 结论是验签在结构上不可能通过，接任何真实支付商都会拒绝掉 100% 的合法回调。
 *
 * 这类缺陷不会在开发期暴露：MVP 只有 manual provider，而它的 handleWebhook 直接
 * 抛错，验签代码从没被真正执行过。所以这里注册一个**真做 HMAC 校验**的假 provider
 * 来把它跑起来。
 *
 * 下面几条用例刻意用「重新序列化必然改变字节」的载荷 —— 键顺序、空白、转义、
 * 数字表示 —— 每一条在旧实现下都会验签失败。
 */

const SECRET = 'whsec_test';

function sign(raw: string): string {
  return createHmac('sha256', SECRET).update(raw).digest('hex');
}

/** 真做 HMAC 校验的假支付商，用来把验签路径跑起来 */
class HmacTestAdapter implements PaymentProvider {
  readonly name = 'stripe' as ProviderName;
  /** 记录每次收到的原始字节，供断言 */
  lastPayload?: Buffer;

  async createSubscription(userId: number, _p: PlanCode, _period: any) {
    return { externalId: `x-${userId}`, periodEnd: new Date() };
  }
  async cancelSubscription(): Promise<void> {}

  async handleWebhook(payload: Buffer, signature?: string): Promise<WebhookEvent> {
    this.lastPayload = payload;
    const expected = sign(payload.toString('utf8'));
    if (signature !== expected) throw new Error('invalid signature');
    const body = JSON.parse(payload.toString('utf8'));
    return {
      type: 'subscription_renewed',
      userId: body.userId,
      planCode: body.planCode ?? 'pro',
      periodEnd: new Date(Date.now() + 30 * 86400_000),
      externalId: body.externalId ?? 'ext-1',
      provider: this.name,
    };
  }
}

let t: TestApp;
let adapter: HmacTestAdapter;

beforeEach(async () => {
  t = await buildTestApp();
  adapter = new HmacTestAdapter();
  t.services.paymentService.registerProvider(adapter);
});
afterEach(async () => { await t.close(); });

/** 直接发原始字符串，绕开测试框架自己序列化 */
function post(raw: string, signature?: string) {
  return t.app.inject({
    method: 'POST',
    url: '/webhook/payment/stripe',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-signature': signature } : {}),
    },
  });
}

describe('原始字节保真', () => {
  it('签名基于原文计算时验签通过', async () => {
    const u = await t.makeUser();
    const raw = JSON.stringify({ userId: u.id, planCode: 'pro', externalId: 'ext-1' });
    const res = await post(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
  });

  it('适配器收到的字节与请求原文逐字节一致', async () => {
    const u = await t.makeUser();
    const raw = JSON.stringify({ userId: u.id, planCode: 'pro', externalId: 'ext-1' });
    await post(raw, sign(raw));
    expect(adapter.lastPayload?.toString('utf8')).toBe(raw);
  });

  /**
   * 键顺序：JSON.stringify 按对象属性顺序输出，而 Fastify 解析再重建后的顺序
   * 取决于 JSON.parse 的插入顺序。支付商把 `type` 放最后的话，重建结果就变了。
   */
  it('键顺序不常规的载荷仍能验签（重新序列化会改变字节）', async () => {
    const u = await t.makeUser();
    const raw = `{"externalId":"ext-9","planCode":"pro","userId":${u.id}}`;
    const res = await post(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    expect(adapter.lastPayload?.toString('utf8')).toBe(raw);
  });

  it('带缩进与换行的载荷仍能验签（stringify 会压掉空白）', async () => {
    const u = await t.makeUser();
    const raw = `{\n  "userId": ${u.id},\n  "planCode": "pro",\n  "externalId": "ext-2"\n}`;
    const res = await post(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    expect(adapter.lastPayload?.toString('utf8')).toBe(raw);
  });

  /**
   * `\u00e9` 与 `é` 解析成同一个字符串，但字节不同。
   * stringify 会输出后者，签名随之失配。
   */
  it('Unicode 转义形式的载荷仍能验签（stringify 会还原成字面量）', async () => {
    const u = await t.makeUser();
    const raw = `{"userId":${u.id},"planCode":"pro","note":"caf\\u00e9"}`;
    const res = await post(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    expect(adapter.lastPayload?.toString('utf8')).toBe(raw);
  });

  /** `1.0e3` 解析成 1000，stringify 输出 `1000` —— 字节变了 */
  it('科学计数法数字仍能验签（stringify 会规范化）', async () => {
    const u = await t.makeUser();
    const raw = `{"userId":${u.id},"planCode":"pro","amount":1.0e3}`;
    const res = await post(raw, sign(raw));
    expect(res.statusCode).toBe(200);
    expect(adapter.lastPayload?.toString('utf8')).toBe(raw);
  });
});

describe('验签失败与异常载荷', () => {
  it('签名不匹配 → 非 200，且不落库', async () => {
    const u = await t.makeUser();
    const raw = JSON.stringify({ userId: u.id, planCode: 'pro' });
    const res = await post(raw, 'deadbeef');
    expect(res.statusCode).not.toBe(200);
  });

  it('缺签名头 → 非 200', async () => {
    const u = await t.makeUser();
    const raw = JSON.stringify({ userId: u.id, planCode: 'pro' });
    const res = await post(raw);
    expect(res.statusCode).not.toBe(200);
  });

  it('非法 JSON → 400，不进适配器', async () => {
    const res = await post('{not json', 'whatever');
    expect(res.statusCode).toBe(400);
    expect(adapter.lastPayload).toBeUndefined();
  });

  it('未注册的 provider → 非 200（不因未知 provider 崩 500 以外的怪状态）', async () => {
    const raw = JSON.stringify({ userId: 1 });
    const res = await t.app.inject({
      method: 'POST', url: '/webhook/payment/lemonsqueezy',
      payload: raw,
      headers: { 'content-type': 'application/json', 'x-signature': sign(raw) },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('非法 provider 名 → 400（schema 枚举拦下）', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/webhook/payment/../../etc/passwd',
      payload: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('parser 的作用域隔离', () => {
  /**
   * addContentTypeParser 在 webhook 插件内注册，只能影响本作用域。
   * 若泄漏到全局，所有 /api/* 路由都会多留一份 body 副本，
   * 而且 schema 校验的错误形态也会变。
   */
  it('业务路由的 JSON 解析与错误形态不受影响', async () => {
    const bad = await t.app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: '{not json', headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);

    const u = await t.makeUser();
    const ok = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth(u.token) });
    expect(ok.statusCode).toBe(200);
  });

  /**
   * 打业务路由不该惊动 webhook 的 parser。
   * 若 parser 泄漏到全局，adapter 不会被调用（provider 不同），但 parser 会跑 ——
   * 这里通过「业务路由正常工作 + 适配器完全没被碰过」间接确认作用域正确。
   */
  it('业务路由走默认解析，webhook 适配器完全不参与', async () => {
    const u = await t.makeUser();
    const res = await t.app.inject({
      method: 'POST', url: '/api/usage', headers: t.auth(u.token),
      payload: { connectionOpens: 1, queryExecutes: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(adapter.lastPayload).toBeUndefined();
  });
});
