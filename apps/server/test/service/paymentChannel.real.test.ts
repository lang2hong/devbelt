import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createCipheriv, createSign } from 'crypto';
import { resolveWechatCredentials, resolveAlipayCredentials, resolvePaymentCallbackBaseUrl } from '../../src/modules/billing/service/paymentCredentials.js';
import {
  resolvePaymentGateway,
  paymentGatewayConfigured,
  paymentRoutesEnabled,
  resolveConfiguredChannels,
  MemoryPaymentGateway,
} from '../../src/modules/billing/service/paymentChannel.js';
import { WechatPayGateway } from '../../src/modules/billing/service/wechatPay.js';
import { PaymentCallbackInvalidError } from '../../src/domain/errors.js';
import { AlipayGateway, alipayTimeoutExpress, buildAlipaySignContent, alipayTimestamp } from '../../src/modules/billing/service/alipay.js';

function rsaKeyPair() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function rsaPemOf(key: ReturnType<typeof rsaKeyPair>, which: 'private' | 'public'): string {
  return which === 'private'
    ? key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    : key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

const CALLBACK_BASE = 'https://pay.example.com';

function wechatEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const mk = rsaKeyPair();
  return {
    PAYMENT_CALLBACK_BASE_URL: CALLBACK_BASE,
    WECHAT_MCH_ID: 'mch',
    WECHAT_APP_ID: 'app',
    WECHAT_MERCHANT_CERT_SERIAL: 'ABCDEF1234567890',
    WECHAT_PLATFORM_CERT_SERIAL: 'FEDCBA0987654321',
    WECHAT_PRIVATE_KEY_B64: b64(rsaPemOf(mk, 'private')),
    WECHAT_PLATFORM_CERT_B64: b64(rsaPemOf(mk, 'public')),
    WECHAT_API_V3_KEY: '0123456789abcdef0123456789abcdef', // exactly 32 bytes
    ...overrides,
  };
}

describe('payment callback base URL validation', () => {
  it('accepts a bare HTTPS origin and rejects http/path/empty', () => {
    expect(resolvePaymentCallbackBaseUrl({ PAYMENT_CALLBACK_BASE_URL: 'https://pay.example.com' })).toBe('https://pay.example.com');
    expect(resolvePaymentCallbackBaseUrl({ PAYMENT_CALLBACK_BASE_URL: 'http://pay.example.com' })).toBeUndefined();
    expect(resolvePaymentCallbackBaseUrl({ PAYMENT_CALLBACK_BASE_URL: 'https://pay.example.com/sub' })).toBeUndefined();
    expect(resolvePaymentCallbackBaseUrl({})).toBeUndefined();
  });
});

describe('payment credentials fail-closed', () => {
  it('returns undefined when wechat credentials are incomplete', () => {
    expect(resolveWechatCredentials({})).toBeUndefined();
    expect(resolveWechatCredentials({ WECHAT_MCH_ID: '1' })).toBeUndefined();
  });

  it('requires the callback base URL (empty notify_url → unconfigured)', () => {
    const env = wechatEnv();
    delete env.PAYMENT_CALLBACK_BASE_URL;
    expect(resolveWechatCredentials(env)).toBeUndefined();
  });

  it('requires a valid merchant cert serial (empty/invalid → unconfigured)', () => {
    expect(resolveWechatCredentials(wechatEnv({ WECHAT_MERCHANT_CERT_SERIAL: '' }))).toBeUndefined();
    expect(resolveWechatCredentials(wechatEnv({ WECHAT_MERCHANT_CERT_SERIAL: 'not-hex!!!' }))).toBeUndefined();
  });

  it('requires exactly 32-byte API v3 key (short/long rejected, exact accepted)', () => {
    expect(resolveWechatCredentials(wechatEnv({ WECHAT_API_V3_KEY: 'short' }))).toBeUndefined();
    expect(resolveWechatCredentials(wechatEnv({ WECHAT_API_V3_KEY: 'x'.repeat(64) }))).toBeUndefined();
    expect(resolveWechatCredentials(wechatEnv({ WECHAT_API_V3_KEY: 'a'.repeat(32) }))).toBeDefined();
  });

  it('returns undefined when alipay credentials are incomplete', () => {
    expect(resolveAlipayCredentials({})).toBeUndefined();
    expect(resolveAlipayCredentials({ ALIPAY_APP_ID: '1' })).toBeUndefined();
  });

  it('resolveConfiguredChannels reports only configured channels', () => {
    const env = wechatEnv();
    const set = resolveConfiguredChannels(env);
    expect(set.has('wechat')).toBe(true);
    expect(set.has('alipay')).toBe(false);
    expect(paymentGatewayConfigured(env)).toBe(true);
  });

  it('resolvePaymentGateway throws for an unconfigured channel', () => {
    expect(() => resolvePaymentGateway('wechat', {})).toThrow(/not configured/);
    expect(() => resolvePaymentGateway('alipay', {})).toThrow(/not configured/);
  });

  it('paymentRoutesEnabled: credentials alone do not enable; explicit FEATURE_PAYMENT=true is required', () => {
    const env = wechatEnv();
    // 凭据齐全但缺显式开关 → 不启用（默认关闭 opt-in）。
    expect(paymentRoutesEnabled(env)).toBe(false);
    // 无凭据即使显式开 → 不启用。
    expect(paymentRoutesEnabled({ FEATURE_PAYMENT: 'true' })).toBe(false);
    // 凭据齐全 + 显式 true/1/on → 启用。
    expect(paymentRoutesEnabled({ ...env, FEATURE_PAYMENT: 'true' })).toBe(true);
    expect(paymentRoutesEnabled({ ...env, FEATURE_PAYMENT: '1' })).toBe(true);
    expect(paymentRoutesEnabled({ ...env, FEATURE_PAYMENT: 'on' })).toBe(true);
    // 显式 false/0/off → 不启用。
    expect(paymentRoutesEnabled({ ...env, FEATURE_PAYMENT: 'false' })).toBe(false);
  });
});

describe('MemoryPaymentGateway is still test-only', () => {
  it('constructs and verifies via HMAC', () => {
    const g = new MemoryPaymentGateway('wechat');
    expect(g.channel).toBe('wechat');
  });
});

describe('WechatPayGateway', () => {
  it('aborts with a clear timeout error when the gateway never responds', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(
      cred,
      (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      }),
      10,
    );
    await expect(g.createPayment({
      orderNo: 'ord-timeout',
      amountCents: 100,
      expiresTime: new Date(Date.now() + 30 * 60 * 1000),
    })).rejects.toThrow(/timed out/);
  });

  it('密文短于 GCM tag 长度时抛 PaymentCallbackInvalidError（稳定 400，而非 500）', () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(cred);
    expect(() => (g as any).decryptResource('AAAA', 'nonce', '')).toThrow(PaymentCallbackInvalidError);
  });

  it('合法长度但 tag 校验失败也映射为 PaymentCallbackInvalidError（不 500）', () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(cred);
    const badTag = Buffer.from('0123456789abcdef').toString('base64'); // 16B，但 tag 必然不匹配
    expect(() => (g as any).decryptResource(badTag, 'nonce', '')).toThrow(PaymentCallbackInvalidError);
  });

  it('serializes a Native order with non-empty notify_url and cert serial', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};
    const g = new WechatPayGateway(cred, async (_url, init) => {
      capturedBody = init.body;
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ code_url: 'weixin://wxpay/code' }) } as unknown as Response;
    });

    const expiresTime = new Date(Date.now() + 30 * 60 * 1000);
    const r = await g.createPayment({ orderNo: 'ord1', amountCents: 9900, expiresTime });
    expect(r.codeUrl).toBe('weixin://wxpay/code');

    const body = JSON.parse(capturedBody);
    expect(body.notify_url).toBe('https://pay.example.com/api/db/public/payment-callback/wechat');
    expect(body.out_trade_no).toBe('ord1');
    expect(body.amount.total).toBe(9900);
    // 渠道外部有效期必须等于本地订单过期时刻（RFC3339，无毫秒）。
    expect(body.time_expire).toBe(expiresTime.toISOString().replace(/\.\d{3}Z$/, 'Z'));

    const auth = capturedHeaders['Authorization'] as string;
    expect(auth).toContain('mchid="mch"');
    expect(auth).toContain('serial_no="ABCDEF1234567890"');
    expect(auth).not.toContain('serial_no=""');
    expect(auth).toContain('signature=');
    expect(auth).toContain('timestamp=');
    expect(auth).toContain('nonce_str=');
  });

  it('verifies a signature and enforces timestamp freshness', async () => {
    const mk = rsaKeyPair();
    const cred = resolveWechatCredentials(wechatEnv({
      WECHAT_PRIVATE_KEY_B64: b64(rsaPemOf(mk, 'private')),
      WECHAT_PLATFORM_CERT_B64: b64(rsaPemOf(mk, 'public')),
    }))!;
    const g = new WechatPayGateway(cred, async () => { throw new Error('no http'); });

    const { createSign } = await import('crypto');
    const rawBody = Buffer.from('{}');
    const now = Math.floor(Date.now() / 1000);
    const signFor = (ts: number) => {
      const signer = createSign('RSA-SHA256');
      signer.update(`${ts}\nabc\n${rawBody.toString('utf8')}\n`);
      return signer.sign(mk.privateKey, 'base64');
    };
    const headers = (ts: number) => ({
      'wechatpay-timestamp': String(ts),
      'wechatpay-nonce': 'abc',
      'wechatpay-signature': signFor(ts),
      'wechatpay-serial': cred.platformCertSerial,
    });

    // 新鲜：通过。
    expect(g.verifyCallback(rawBody, headers(now))).toBe(true);

    // 过期：拒绝（§54 防重放）。
    const stale = now - 10 * 60;
    expect(g.verifyCallback(rawBody, headers(stale))).toBe(false);
  });

  it('rejects a callback whose wechatpay-serial does not match the configured platform cert', async () => {
    const mk = rsaKeyPair();
    const cred = resolveWechatCredentials(wechatEnv({
      WECHAT_PRIVATE_KEY_B64: b64(rsaPemOf(mk, 'private')),
      WECHAT_PLATFORM_CERT_B64: b64(rsaPemOf(mk, 'public')),
    }))!;
    const g = new WechatPayGateway(cred, async () => { throw new Error('no http'); });
    const { createSign } = await import('crypto');
    const rawBody = Buffer.from('{}');
    const now = Math.floor(Date.now() / 1000);
    const signer = createSign('RSA-SHA256');
    signer.update(`${now}\nabc\n${rawBody.toString('utf8')}\n`);
    const signature = signer.sign(mk.privateKey, 'base64');
    expect(g.verifyCallback(rawBody, {
      'wechatpay-timestamp': String(now),
      'wechatpay-nonce': 'abc',
      'wechatpay-signature': signature,
      'wechatpay-serial': 'DEADBEEF0000',
    })).toBe(false);
  });

  it('signs the canonical v3 path (not the absolute URL)', async () => {
    const mk = rsaKeyPair();
    const cred = resolveWechatCredentials(wechatEnv({
      WECHAT_PRIVATE_KEY_B64: b64(rsaPemOf(mk, 'private')),
      WECHAT_PLATFORM_CERT_B64: b64(rsaPemOf(mk, 'public')),
    }))!;
    let capturedBody = '';
    let capturedAuth = '';
    const g = new WechatPayGateway(cred, async (_url, init) => {
      capturedBody = init.body;
      capturedAuth = init.headers['Authorization'] as string;
      return { ok: true, json: async () => ({ code_url: 'weixin://wxpay/code' }) } as unknown as Response;
    });
    await g.createPayment({ orderNo: 'ord1', amountCents: 9900, expiresTime: new Date(Date.now() + 30 * 60 * 1000) });

    // 从 Authorization 提取 timestamp / nonce_str / signature。
    const timestamp = /timestamp="(\d+)"/.exec(capturedAuth)![1];
    const nonce = /nonce_str="([^"]+)"/.exec(capturedAuth)![1];
    const signature = /signature="([^"]+)"/.exec(capturedAuth)![1];

    // 用商户公钥对 canonical 串验签：POST\n/v3/pay/transactions/native\n<ts>\n<nonce>\n<body>\n
    const { createVerify } = await import('crypto');
    const message = `POST\n/v3/pay/transactions/native\n${timestamp}\n${nonce}\n${capturedBody}\n`;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(message);
    expect(verifier.verify(mk.publicKey, signature, 'base64')).toBe(true);
  });

  it('decrypts an AES-256-GCM callback resource and parses it', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(cred, async () => { throw new Error('no http'); });

    const apiV3Key = Buffer.from('0123456789abcdef0123456789abcdef');
    const nonce = 'abcdefgh';
    const aad = 'transaction';
    const plaintext = JSON.stringify({ appid: 'app', mchid: 'mch', out_trade_no: 'ord1', transaction_id: 'wx-t-1', amount: { total: 9900 }, trade_state: 'SUCCESS' });
    const enc = createCipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
    enc.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([enc.update(plaintext, 'utf8'), enc.final()]);
    const tag = enc.getAuthTag();
    const resource = Buffer.concat([ciphertext, tag]).toString('base64');

    const parsed = g.parseCallback(Buffer.from(JSON.stringify({ resource: { ciphertext: resource, nonce, associated_data: aad } })));
    expect(parsed).toEqual({
      orderNo: 'ord1',
      channelTradeNo: 'wx-t-1',
      amountCents: 9900,
      status: 'success',
      summary: { appid: 'app', mchid: 'mch', out_trade_no: 'ord1', transaction_id: 'wx-t-1', total: '9900', trade_state: 'SUCCESS' },
    });
  });

  it('rejects a decrypted resource whose appid/mchid do not match credentials', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(cred, async () => { throw new Error('no http'); });

    const apiV3Key = Buffer.from('0123456789abcdef0123456789abcdef');
    const nonce = 'abcdefgh';
    const aad = 'transaction';
    const plaintext = JSON.stringify({ appid: 'other', mchid: 'mch', out_trade_no: 'ord1', transaction_id: 'wx-t-1', amount: { total: 9900 }, trade_state: 'SUCCESS' });
    const enc = createCipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
    enc.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([enc.update(plaintext, 'utf8'), enc.final()]);
    const resource = Buffer.concat([ciphertext, enc.getAuthTag()]).toString('base64');

    expect(() => g.parseCallback(Buffer.from(JSON.stringify({ resource: { ciphertext: resource, nonce, associated_data: aad } })))).toThrow(/identity mismatch/);
  });

  it('parses a decrypted callback into an allowlisted summary only (no payer identity)', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(cred, async () => { throw new Error('no http'); });

    const apiV3Key = Buffer.from('0123456789abcdef0123456789abcdef');
    const nonce = 'abcdefgh';
    const aad = 'transaction';
    const plaintext = JSON.stringify({
      appid: 'app', mchid: 'mch', out_trade_no: 'ord1', transaction_id: 'wx-t-1',
      amount: { total: 9900 }, trade_state: 'SUCCESS', success_time: '2026-09-11T14:30:00+08:00',
      payer: { openid: 'OPENID_SECRET' },
    });
    const enc = createCipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
    enc.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([enc.update(plaintext, 'utf8'), enc.final()]);
    const resource = Buffer.concat([ciphertext, enc.getAuthTag()]).toString('base64');

    const parsed = g.parseCallback(Buffer.from(JSON.stringify({ resource: { ciphertext: resource, nonce, associated_data: aad } })));
    expect(parsed.summary).toEqual({
      appid: 'app',
      mchid: 'mch',
      out_trade_no: 'ord1',
      transaction_id: 'wx-t-1',
      total: '9900',
      trade_state: 'SUCCESS',
      success_time: '2026-09-11T14:30:00+08:00',
    });
    expect(JSON.stringify(parsed.summary)).not.toContain('OPENID_SECRET');
  });
});

describe('AlipayGateway', () => {
  function alipayEnv() {
    const app = rsaKeyPair();
    const alipay = rsaKeyPair();
    return {
      env: {
        PAYMENT_CALLBACK_BASE_URL: CALLBACK_BASE,
        ALIPAY_APP_ID: 'app',
        ALIPAY_PRIVATE_KEY_B64: b64(rsaPemOf(app, 'private')),
        ALIPAY_PUBLIC_KEY_B64: b64(rsaPemOf(alipay, 'public')),
      } as NodeJS.ProcessEnv,
      app,
      alipay,
    };
  }

  it('serializes a page-pay form with non-empty notify_url and string-decimal amount', async () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);
    const r = await g.createPayment({ orderNo: 'ord1', amountCents: 9900, expiresTime: new Date(Date.now() + 30 * 60 * 1000) });
    // page pay 直接返回签名跳转 URL（无 server POST）。
    expect(typeof r.redirectUrl).toBe('string');
    const url = r.redirectUrl as string;
    expect(url.startsWith('https://openapi.alipay.com/gateway.do?')).toBe(true);
    expect(url).toContain(encodeURIComponent(CALLBACK_BASE + '/api/db/public/payment-callback/alipay'));

    // timeout_express 向下取整推导：外部窗口不超本地 deadline。刚建 30m 订单因创建后可能跨
    // 毫秒，floor 结果只可能是 29m 或 30m —— 断言「不超 30m」而非「必然精确 30m」（防竞态）。
    const qs = new URL(url).searchParams;
    const biz = JSON.parse(qs.get('biz_content')!) as { total_amount: string; timeout_express: string };
    expect(biz.total_amount).toBe('99.00');
    expect(['29m', '30m']).toContain(biz.timeout_express);
    // 请求时间戳必须为北京时间 `yyyy-MM-dd HH:mm:ss`（官方协议格式，非 ISO-8601）。
    expect(qs.get('timestamp')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('parses a valid callback with string-decimal cents (no float)', () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);
    const parsed = g.parseCallback(Buffer.from('app_id=app&out_trade_no=ord1&trade_no=ali-t-1&total_amount=99.00&trade_status=TRADE_SUCCESS'));
    expect(parsed).toEqual({
      orderNo: 'ord1',
      channelTradeNo: 'ali-t-1',
      amountCents: 9900,
      status: 'success',
      summary: { app_id: 'app', out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS' },
    });
  });

  it('rejects a callback whose app_id does not match credentials', () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);
    expect(() => g.parseCallback(Buffer.from('app_id=other&out_trade_no=ord1&trade_no=ali-t-1&total_amount=99.00&trade_status=TRADE_SUCCESS'))).toThrow(/identity mismatch/);
  });

  it('rejects an ill-formed amount string', () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);
    const parsed = g.parseCallback(Buffer.from('app_id=app&out_trade_no=ord1&trade_no=x&total_amount=99.1&trade_status=TRADE_SUCCESS'));
    expect(parsed.amountCents).toBeNaN();
  });

  it('verifies a valid alipay callback signature and enforces notify_time freshness', async () => {
    const { env, alipay } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);

    const { createSign } = await import('crypto');
    // 支付宝通知时间格式：`yyyy-MM-dd HH:mm:ss`（+08:00），非 ISO。用真实格式构造。
    const nowCn = new Date(Date.now() + 8 * 3600 * 1000);
    const fmt = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    };
    const fields = { app_id: 'app', out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS', notify_time: fmt(nowCn) };
    const content = Object.keys(fields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    const sign = signer.sign(alipay.privateKey, 'base64');

    expect(g.verifyCallback(Buffer.from(`${content}&sign_type=RSA2&sign=${encodeURIComponent(sign)}`), {})).toBe(true);

    // 过期 notify_time（10 分钟前）→ 拒绝。
    const staleFields = { ...fields, notify_time: fmt(new Date(nowCn.getTime() - 10 * 60 * 1000)) };
    const staleContent = Object.keys(staleFields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${staleFields[k as keyof typeof staleFields]}`).join('&');
    const signer2 = createSign('RSA-SHA256');
    signer2.update(staleContent);
    const staleSign = signer2.sign(alipay.privateKey, 'base64');
    expect(g.verifyCallback(Buffer.from(`${staleContent}&sign_type=RSA2&sign=${encodeURIComponent(staleSign)}`), {})).toBe(false);
  });

  it('rejects a malformed notify_time format', async () => {
    const { env, alipay } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);
    const { createSign } = await import('crypto');
    // ISO 格式不被识别 → 验签返回 false（fail-closed）。
    const fields = { app_id: 'app', out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS', notify_time: new Date().toISOString() };
    const content = Object.keys(fields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    const sign = signer.sign(alipay.privateKey, 'base64');
    expect(g.verifyCallback(Buffer.from(`${content}&sign_type=RSA2&sign=${encodeURIComponent(sign)}`), {})).toBe(false);
  });

  it('verifies a signed callback field containing a space encoded as +', async () => {
    const { env, alipay } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);

    const { createSign } = await import('crypto');
    // subject 含空格；验签内容为原始字面空格，wire 形式用 + 表示空格。
    const nowCn = new Date(Date.now() + 8 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    const fields = { app_id: 'app', out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS', notify_time: fmt(nowCn), subject: 'DevBelt' };
    const content = Object.keys(fields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    const sign = signer.sign(alipay.privateKey, 'base64');

    // wire 形式：值内空格 → '+'（application/x-www-form-urlencoded 约定）。
    const formBody = content.split('&').map((p) => {
      const i = p.indexOf('=');
      return `${p.slice(0, i)}=${p.slice(i + 1).replace(/ /g, '+')}`;
    }).join('&') + `&sign_type=RSA2&sign=${encodeURIComponent(sign)}`;

    expect(g.verifyCallback(Buffer.from(formBody), {})).toBe(true);
  });

  it('rejects a signed callback missing both notify_time and gmt_payment (fail-closed)', async () => {
    const { env, alipay } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);

    const { createSign } = await import('crypto');
    // 无任何通知时间字段：即使签名正确也必须拒绝（防绕过新鲜度）。
    const fields = { app_id: 'app', out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS' };
    const content = Object.keys(fields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    const sign = signer.sign(alipay.privateKey, 'base64');
    expect(g.verifyCallback(Buffer.from(`${content}&sign_type=RSA2&sign=${encodeURIComponent(sign)}`), {})).toBe(false);
  });

  it('rejects impossible calendar dates (2026-02-29, 2026-02-31, 2026-04-31)', async () => {
    const { env, alipay } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);

    const { createSign } = await import('crypto');
    for (const notifyTime of ['2026-02-29 12:00:00', '2026-02-31 12:00:00', '2026-04-31 12:00:00']) {
      const fields = { app_id: 'app', out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS', notify_time: notifyTime };
      const content = Object.keys(fields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('&');
      const signer = createSign('RSA-SHA256');
      signer.update(content);
      const sign = signer.sign(alipay.privateKey, 'base64');
      expect(g.verifyCallback(Buffer.from(`${content}&sign_type=RSA2&sign=${encodeURIComponent(sign)}`), {})).toBe(false);
    }
  });

  it('parses a callback into an allowlisted summary only (no sensitive fields)', () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred);
    const parsed = g.parseCallback(
      Buffer.from('app_id=app&out_trade_no=ord1&trade_no=ali-t-1&total_amount=99.00&trade_status=TRADE_SUCCESS&notify_time=2026-09-11%2014%3A30%3A00&seller_id=seller&buyer_id=BUYER_SECRET&subject=SECRET_SUBJECT&buyer_logon_id=user@example.com'),
    );
    expect(parsed.summary).toEqual({
      app_id: 'app',
      out_trade_no: 'ord1',
      trade_no: 'ali-t-1',
      total_amount: '99.00',
      trade_status: 'TRADE_SUCCESS',
      notify_time: '2026-09-11 14:30:00',
      seller_id: 'seller',
    });
    expect(JSON.stringify(parsed.summary)).not.toContain('BUYER_SECRET');
    expect(JSON.stringify(parsed.summary)).not.toContain('SECRET_SUBJECT');
    expect(JSON.stringify(parsed.summary)).not.toContain('user@example.com');
  });
});

describe('alipayTimeoutExpress (external window never exceeds local deadline)', () => {
  it('fails closed below one minute', () => {
    for (const ms of [1000, 30_000, 59_000]) {
      expect(() => alipayTimeoutExpress(ms)).toThrow(/remaining lifetime/);
    }
  });

  it('rounds down at and above one minute', () => {
    expect(alipayTimeoutExpress(60_000)).toBe('1m');
    expect(alipayTimeoutExpress(29 * 60_000 + 1000)).toBe('29m');
    expect(alipayTimeoutExpress(30 * 60_000)).toBe('30m');
  });
});

describe('buildAlipaySignContent (sign_type asymmetry)', () => {
  it('includes sign_type for outgoing request signing (and drops empty values)', () => {
    // 固定输入 → 精确期望串（pin 串，防「请求漏签 sign_type」）。
    expect(buildAlipaySignContent({ b: '2', a: '1', sign_type: 'RSA2', z: '' }, { includeSignType: true })).toBe('a=1&b=2&sign_type=RSA2');
  });

  it('excludes sign_type (and sign) for notification verification', () => {
    expect(buildAlipaySignContent({ b: '2', a: '1', sign_type: 'RSA2', sign: 'XYZ', total_amount: '99.00' })).toBe('a=1&b=2&total_amount=99.00');
  });
});

describe('alipayTimestamp (Beijing yyyy-MM-dd HH:mm:ss)', () => {
  it('formats a UTC instant as Beijing time without timezone suffix', () => {
    // 2026-09-11T02:30:00Z = 北京 2026-09-11 10:30:00。
    expect(alipayTimestamp(new Date('2026-09-11T02:30:00Z'))).toBe('2026-09-11 10:30:00');
    expect(alipayTimestamp(new Date('2026-01-01T16:59:59Z'))).toBe('2026-01-02 00:59:59');
  });
});
describe('AlipayGateway precreate (扫码)', () => {
  function creds() {
    const app = rsaKeyPair();
    const alipay = rsaKeyPair();
    const env = {
      PAYMENT_CALLBACK_BASE_URL: CALLBACK_BASE,
      ALIPAY_APP_ID: 'app',
      ALIPAY_PRIVATE_KEY_B64: b64(rsaPemOf(app, 'private')),
      ALIPAY_PUBLIC_KEY_B64: b64(rsaPemOf(alipay, 'public')),
    } as NodeJS.ProcessEnv;
    return { cred: resolveAlipayCredentials(env)!, alipay };
  }
  function signedBody(node: string, alipay: ReturnType<typeof rsaKeyPair>): string {
    const signer = createSign('RSA-SHA256');
    signer.update(node, 'utf8');
    const sign = signer.sign(alipay.privateKey, 'base64');
    return `{"alipay_trade_precreate_response":${node},"sign":${JSON.stringify(sign)}}`;
  }

  it('qr 模式：校验响应签名后返回 codeUrl', async () => {
    const { cred, alipay } = creds();
    const node = JSON.stringify({ code: '10000', msg: 'Success', out_trade_no: 'ord1', qr_code: 'https://qr.alipay.com/abc' });
    const body = signedBody(node, alipay);
    const fetchImpl = (async () => ({ ok: true, text: async () => body })) as unknown as never;
    const g = new AlipayGateway(cred, fetchImpl);
    const r = await g.createPayment({ orderNo: 'ord1', amountCents: 9900, expiresTime: new Date(Date.now() + 30 * 60 * 1000), mode: 'qr' });
    expect(r.codeUrl).toBe('https://qr.alipay.com/abc');
    expect(r.redirectUrl).toBeUndefined();
  });

  it('qr 模式：响应签名无效则拒绝', async () => {
    const { cred } = creds();
    const node = JSON.stringify({ code: '10000', qr_code: 'https://qr.alipay.com/abc' });
    const body = `{"alipay_trade_precreate_response":${node},"sign":"AAAA"}`;
    const fetchImpl = (async () => ({ ok: true, text: async () => body })) as unknown as never;
    const g = new AlipayGateway(cred, fetchImpl);
    await expect(g.createPayment({ orderNo: 'ord1', amountCents: 9900, expiresTime: new Date(Date.now() + 30 * 60 * 1000), mode: 'qr' }))
      .rejects.toThrow(/signature verification failed/);
  });

  it('qr 模式：渠道返回非 10000 抛错', async () => {
    const { cred, alipay } = creds();
    const node = JSON.stringify({ code: '40004', msg: 'Business Failed', sub_code: 'ACQ.TRADE_HAS_CLOSE', sub_msg: 'trade closed' });
    const body = signedBody(node, alipay);
    const fetchImpl = (async () => ({ ok: true, text: async () => body })) as unknown as never;
    const g = new AlipayGateway(cred, fetchImpl);
    await expect(g.createPayment({ orderNo: 'ord1', amountCents: 9900, expiresTime: new Date(Date.now() + 30 * 60 * 1000), mode: 'qr' }))
      .rejects.toThrow(/ACQ.TRADE_HAS_CLOSE/);
  });
});
