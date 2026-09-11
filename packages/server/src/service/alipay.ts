import { createSign, createVerify } from 'crypto';
import type { PaymentGateway, PrepayParams, PaymentCallback } from './paymentChannel.js';
import type { AlipayCredentials } from './paymentCredentials.js';

/**
 * 支付宝（网页 H5）适配器（P4 切片 4B）。
 *
 * - 下单：RSA2(RSA-SHA256) 对表单键值串排序签名，经注入 `fetchImpl` 发往网关。
 * - 回调验签：对回调表单除 sign/sign_type 外的键按字典序拼 `k=v` 用 `&` 连接，
 *   以支付宝公钥 RSA2 验签。
 * - 回调解析：表单归一化。
 *
 * 真实到支付宝沙箱的端到端联调属部署后人工验收（§83/§84）；本适配器密码学逻辑用
 * 测试密钥可离线验证，真实 HTTP 由 `fetchImpl` 注入以便测试 stub。
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

const ALIPAY_ORDER_URL = 'https://openapi.alipay.com/gateway.do';

/** 分 → 元整数字符串（无浮点，§75）。 */
function yuanFromCents(cents: number): string {
  const yuan = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${yuan}.${String(frac).padStart(2, '0')}`;
}

/** 元字符串（\d+.\d{2}）→ 分；非法格式返回 NaN（调用端拒绝/复核拦截）。§75 无浮点。 */
function centsFromYuan(s: string): number {
  const m = /^(\d+)\.(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number(m[2]);
}

export class AlipayGateway implements PaymentGateway {
  readonly channel = 'alipay' as const;

  /** 回调时间戳新鲜度窗口（§54 防重放）：±5 分钟。 */
  static readonly FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

  constructor(
    private readonly creds: AlipayCredentials,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async createPayment(input: { orderNo: string; amountCents: number }): Promise<PrepayParams> {
    const biz = {
      out_trade_no: input.orderNo,
      total_amount: yuanFromCents(input.amountCents),
      subject: 'DB Client Pro subscription',
      product_code: 'FAST_INSTANT_TRADE_PAY',
    };
    const params: Record<string, string> = {
      app_id: this.creds.appId,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      version: '1.0',
      notify_url: this.creds.callbackUrl,
      biz_content: JSON.stringify(biz),
    };
    const sign = this.sign(params);
    const body = this.toFormBody({ ...params, sign });

    const res = await this.fetchImpl(ALIPAY_ORDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`alipay page pay failed: HTTP ${res.status}`);
    // 页面支付实际是「构造带签名的表单 URL 供浏览器跳转」；此处返回可直接打开的 URL。
    return { redirectUrl: `${ALIPAY_ORDER_URL}?${body}` };
  }

  verifyCallback(rawBody: Buffer, _headers: Record<string, string>): boolean {
    const form = this.parseForm(rawBody.toString('utf8'));
    const sign = form.sign;
    if (!sign) return false;
    // §54 防重放：回调携带的 timestamp（ISO 格式）须落在新鲜度窗口内。
    const timestamp = form.timestamp;
    if (timestamp) {
      const ts = Date.parse(timestamp);
      if (Number.isNaN(ts)) return false;
      if (Math.abs(Date.now() - ts) > AlipayGateway.FRESHNESS_WINDOW_MS) return false;
    }
    const content = this.buildSignContent(form);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(content);
    return verifier.verify(this.creds.alipayPublicKey, sign, 'base64');
  }

  parseCallback(rawBody: Buffer): PaymentCallback {
    const form = this.parseForm(rawBody.toString('utf8'));
    const orderNo = form.out_trade_no;
    const tradeNo = form.trade_no;
    if (!orderNo || !tradeNo) throw new Error('alipay callback missing trade fields');
    return {
      orderNo,
      channelTradeNo: tradeNo,
      amountCents: centsFromYuan(form.total_amount ?? ''),
      status: form.trade_status === 'TRADE_SUCCESS' || form.trade_status === 'TRADE_FINISHED' ? 'success' : 'failure',
    };
  }

  private sign(params: Record<string, string>): string {
    const content = this.buildSignContent(params);
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    return signer.sign(this.creds.appPrivateKey, 'base64');
  }

  private buildSignContent(params: Record<string, string>): string {
    return Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  private toFormBody(params: Record<string, string>): string {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  private parseForm(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of body.split('&')) {
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
    }
    return out;
  }
}