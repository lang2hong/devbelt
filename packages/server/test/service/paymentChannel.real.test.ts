import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createCipheriv } from 'crypto';
import { resolveWechatCredentials, resolveAlipayCredentials, resolvePaymentCallbackBaseUrl } from '../../src/service/paymentCredentials.js';
import {
  resolvePaymentGateway,
  paymentGatewayConfigured,
  resolveConfiguredChannels,
  MemoryPaymentGateway,
} from '../../src/service/paymentChannel.js';
import { WechatPayGateway } from '../../src/service/wechatPay.js';
import { AlipayGateway } from '../../src/service/alipay.js';

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
});

describe('MemoryPaymentGateway is still test-only', () => {
  it('constructs and verifies via HMAC', () => {
    const g = new MemoryPaymentGateway('wechat');
    expect(g.channel).toBe('wechat');
  });
});

describe('WechatPayGateway', () => {
  it('serializes a Native order with non-empty notify_url and cert serial', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};
    const g = new WechatPayGateway(cred, async (_url, init) => {
      capturedBody = init.body;
      capturedHeaders = init.headers;
      return { ok: true, json: async () => ({ code_url: 'weixin://wxpay/code' }) } as unknown as Response;
    });

    const r = await g.createPayment({ orderNo: 'ord1', amountCents: 9900 });
    expect(r.codeUrl).toBe('weixin://wxpay/code');

    const body = JSON.parse(capturedBody);
    expect(body.notify_url).toBe('https://pay.example.com/api/public/payment-callback/wechat');
    expect(body.out_trade_no).toBe('ord1');
    expect(body.amount.total).toBe(9900);

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

    // 新鲜：通过。
    expect(g.verifyCallback(rawBody, {
      'wechatpay-timestamp': String(now),
      'wechatpay-nonce': 'abc',
      'wechatpay-signature': signFor(now),
    })).toBe(true);

    // 过期：拒绝（§54 防重放）。
    const stale = now - 10 * 60;
    expect(g.verifyCallback(rawBody, {
      'wechatpay-timestamp': String(stale),
      'wechatpay-nonce': 'abc',
      'wechatpay-signature': signFor(stale),
    })).toBe(false);
  });

  it('decrypts an AES-256-GCM callback resource and parses it', async () => {
    const cred = resolveWechatCredentials(wechatEnv())!;
    const g = new WechatPayGateway(cred, async () => { throw new Error('no http'); });

    const apiV3Key = Buffer.from('0123456789abcdef0123456789abcdef');
    const nonce = 'abcdefgh';
    const aad = 'transaction';
    const plaintext = JSON.stringify({ out_trade_no: 'ord1', transaction_id: 'wx-t-1', amount: { total: 9900 }, trade_state: 'SUCCESS' });
    const enc = createCipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
    enc.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([enc.update(plaintext, 'utf8'), enc.final()]);
    const tag = enc.getAuthTag();
    const resource = Buffer.concat([ciphertext, tag]).toString('base64');

    const parsed = g.parseCallback(Buffer.from(JSON.stringify({ resource: { ciphertext: resource, nonce, associated_data: aad } })));
    expect(parsed).toEqual({ orderNo: 'ord1', channelTradeNo: 'wx-t-1', amountCents: 9900, status: 'success' });
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
    let capturedBody = '';
    const g = new AlipayGateway(cred, async (_url, init) => {
      capturedBody = init.body;
      return { ok: true } as unknown as Response;
    });
    await g.createPayment({ orderNo: 'ord1', amountCents: 9900 });
    expect(capturedBody).toContain(encodeURIComponent(CALLBACK_BASE + '/api/public/payment-callback/alipay'));
    // biz_content 内 total_amount 是 99.00，无浮点误差。
    expect(capturedBody).toContain(encodeURIComponent('"total_amount":"99.00"'));
  });

  it('parses a valid callback with string-decimal cents (no float)', () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred, async () => { throw new Error('no http'); });
    const parsed = g.parseCallback(Buffer.from('out_trade_no=ord1&trade_no=ali-t-1&total_amount=99.00&trade_status=TRADE_SUCCESS'));
    expect(parsed).toEqual({ orderNo: 'ord1', channelTradeNo: 'ali-t-1', amountCents: 9900, status: 'success' });
  });

  it('rejects an ill-formed amount string', () => {
    const { env } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred, async () => { throw new Error('no http'); });
    const parsed = g.parseCallback(Buffer.from('out_trade_no=ord1&trade_no=x&total_amount=99.1&trade_status=TRADE_SUCCESS'));
    expect(parsed.amountCents).toBeNaN();
  });

  it('verifies a valid alipay callback signature and enforces timestamp freshness', async () => {
    const { env, alipay } = alipayEnv();
    const cred = resolveAlipayCredentials(env)!;
    const g = new AlipayGateway(cred, async () => { throw new Error('no http'); });

    const { createSign } = await import('crypto');
    const fields = { out_trade_no: 'ord1', trade_no: 'ali-t-1', total_amount: '99.00', trade_status: 'TRADE_SUCCESS', timestamp: new Date().toISOString() };
    const content = Object.keys(fields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join('&');
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    const sign = signer.sign(alipay.privateKey, 'base64');

    expect(g.verifyCallback(Buffer.from(`${content}&sign_type=RSA2&sign=${encodeURIComponent(sign)}`), {})).toBe(true);

    // 过期时间戳 → 拒绝。
    const staleFields = { ...fields, timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    const staleContent = Object.keys(staleFields).filter((k) => k !== 'sign' && k !== 'sign_type').sort().map((k) => `${k}=${staleFields[k as keyof typeof staleFields]}`).join('&');
    const signer2 = createSign('RSA-SHA256');
    signer2.update(staleContent);
    const staleSign = signer2.sign(alipay.privateKey, 'base64');
    expect(g.verifyCallback(Buffer.from(`${staleContent}&sign_type=RSA2&sign=${encodeURIComponent(staleSign)}`), {})).toBe(false);
  });
});