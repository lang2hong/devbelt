import { createSign, createVerify } from 'crypto';
import type { PaymentGateway, PrepayParams, PaymentCallback } from './paymentChannel.js';
import type { AlipayCredentials } from './paymentCredentials.js';
import { PaymentCallbackInvalidError, PaymentGatewayError } from '../domain/errors.js';

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
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

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

/** 通知脱敏白名单字段（不含 buyer/subject/邮箱等敏感项）。 */
const ALIPAY_SUMMARY_FIELDS = ['out_trade_no', 'trade_no', 'total_amount', 'trade_status', 'notify_time', 'gmt_payment', 'app_id', 'seller_id'] as const;

/** 通知脱敏：仅保留白名单字段，绝不落完整表单（P1 敏感信息边界）。 */
function alipaySummary(form: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ALIPAY_SUMMARY_FIELDS) {
    const v = form[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * 剩余毫秒 → 支付宝 timeout_express（向下取整，外部窗口绝不超本地 deadline；<1m fail-closed）。
 * 用 floor 而非 ceil：向上取整会让外部有效期越过本地 expiry（本地过期后合法回调只能 recorded
 * 无法履约）。分钟粒度无法表示小于 1m 的窗口时抛错，由服务层在建单前拦截（P0）。
 */
export function alipayTimeoutExpress(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) {
    throw new Error('alipay timeout_express: remaining lifetime < 1m cannot be represented without exceeding the local deadline');
  }
  return `${minutes}m`;
}

/** 剩余寿命 → 支付宝 timeout_express。 */
function timeoutExpress(expiresTime: Date): string {
  return alipayTimeoutExpress(expiresTime.getTime() - Date.now());
}

/** 支付宝通知时间 `yyyy-MM-dd HH:mm:ss`（Asia/Shanghai）→ epoch ms；非法返回 null。 */
function parseAlipayTime(s: string): number | null {
  // 支付宝异步通知 notify_time 典型形态：`2026-09-11 14:30:00`（无时区，语义 +08:00）。
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  // 严格日历：Date.UTC 会归一化非法日期（如 2026-02-31 → 3 月），须回验各分量，
  // 否则不可能的渠道时间戳会通过新鲜度校验（P1）。
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== sec
  ) {
    return null;
  }
  // 用 UTC 分量构造，再减 8 小时偏移得到 epoch ms（+08:00 → UTC）。
  return date.getTime() - 8 * 3600 * 1000;
}

/** 支付宝请求时间戳：北京时间 `yyyy-MM-dd HH:mm:ss`（官方 SDK/协议格式，非 ISO-8601）。 */
export function alipayTimestamp(now: Date = new Date()): string {
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())} ${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}:${p(sh.getUTCSeconds())}`;
}

/**
 * 支付宝签名串构造（不对称，P1）：
 * - 请求签名（`includeSignType=true`）：`sign_type` 本身是发往支付宝的请求参数，参与签名，
 *   仅排除 `sign` 与空值；
 * - 异步通知验签（默认）：排除 `sign` 与 `sign_type`。
 * 键按字典序排列，`k=v` 用 `&` 连接；空值/undefined 不参与。
 */
export function buildAlipaySignContent(params: Record<string, string>, opts: { includeSignType?: boolean } = {}): string {
  const excludeSignType = !opts.includeSignType;
  return Object.keys(params)
    .filter((k) => {
      if (k === 'sign') return false;
      if (excludeSignType && k === 'sign_type') return false;
      const v = params[k];
      return v !== '' && v !== undefined;
    })
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** 预下单 HTTP 默认超时。 */
const DEFAULT_ORDER_TIMEOUT_MS = 10_000;

/**
 * 从网关响应的**原始文本**中截取某个响应节点的精确 JSON 子串。
 * 支付宝要求对响应节点文本本身验签，不能 `JSON.parse` 后再序列化（键序/空白会变）。
 */
function extractResponseNode(raw: string, key: string): string | undefined {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return undefined;
  const colon = raw.indexOf(':', at + key.length + 2);
  if (colon < 0) return undefined;
  let i = colon + 1;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] !== '{') return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = i; j < raw.length; j++) {
    const ch = raw[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(i, j + 1);
    }
  }
  return undefined;
}

export class AlipayGateway implements PaymentGateway {
  readonly channel = 'alipay' as const;

  /** 回调时间戳新鲜度窗口（§54 防重放）：±5 分钟。 */
  static readonly FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

  constructor(
    private readonly creds: AlipayCredentials,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly orderTimeoutMs: number = DEFAULT_ORDER_TIMEOUT_MS,
  ) {}

  async createPayment(input: { orderNo: string; amountCents: number; expiresTime: Date; mode?: 'qr' | 'redirect' }): Promise<PrepayParams> {
    // 支付宝扫码用 `alipay.trade.precreate`（返回 qr_code）；跳转用 `alipay.trade.page.pay`。
    if (input.mode === 'qr') return this.createQr(input);
    return this.createPage(input);
  }

  /** 扫码支付：`alipay.trade.precreate` → `qr_code`（服务端 HTTP 调用 + 响应验签）。 */
  private async createQr(input: { orderNo: string; amountCents: number; expiresTime: Date }): Promise<PrepayParams> {
    const biz = {
      out_trade_no: input.orderNo,
      total_amount: yuanFromCents(input.amountCents),
      subject: 'DevBelt subscription',
      timeout_express: timeoutExpress(input.expiresTime),
    };
    const params: Record<string, string> = {
      app_id: this.creds.appId,
      method: 'alipay.trade.precreate',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(),
      version: '1.0',
      notify_url: this.creds.callbackUrl,
      biz_content: JSON.stringify(biz),
    };
    const sign = this.sign(params);
    const body = this.toFormBody({ ...params, sign });
    const res = await this.fetchImpl(ALIPAY_ORDER_URL, {
      method: 'POST',
      // 必须显式带 charset：支付宝按请求 Content-Type 决定**响应**字符集；缺省时
      // 返回 GBK 字节，按 UTF-8 解码会破坏响应文本（含中文/错误信息）导致验签失败。
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
      signal: AbortSignal.timeout(this.orderTimeoutMs),
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === 'TimeoutError') throw new PaymentGatewayError('alipay precreate timed out');
      throw new PaymentGatewayError(`alipay precreate request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!res.ok) throw new PaymentGatewayError(`alipay precreate failed: HTTP ${res.status}`);
    const text = await res.text();
    const node = extractResponseNode(text, 'alipay_trade_precreate_response');
    if (!node) throw new PaymentGatewayError('alipay precreate returned no response node');
    let outer: { sign?: string };
    try {
      outer = JSON.parse(text) as { sign?: string };
    } catch {
      throw new PaymentGatewayError('alipay precreate returned malformed JSON');
    }
    if (!outer.sign || !this.verifyNode(node, outer.sign)) {
      throw new PaymentGatewayError('alipay precreate response signature verification failed');
    }
    const parsed = JSON.parse(node) as { code?: string; msg?: string; sub_code?: string; sub_msg?: string; qr_code?: string };
    if (parsed.code !== '10000' || !parsed.qr_code) {
      throw new PaymentGatewayError(
        `alipay precreate rejected: ${parsed.sub_code ?? parsed.code ?? 'unknown'} ${parsed.sub_msg ?? parsed.msg ?? ''}`.trim(),
      );
    }
    return { codeUrl: parsed.qr_code };
  }

  /** 对响应节点文本用支付宝公钥做 RSA2 验签。 */
  private verifyNode(nodeText: string, sign: string): boolean {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(nodeText, 'utf8');
    return verifier.verify(this.creds.alipayPublicKey, sign, 'base64');
  }

  /** 跳转支付：`alipay.trade.page.pay` 签名表单 URL（无服务端 HTTP 调用）。 */
  private createPage(input: { orderNo: string; amountCents: number; expiresTime: Date }): PrepayParams {
    const biz = {
      out_trade_no: input.orderNo,
      total_amount: yuanFromCents(input.amountCents),
      subject: 'DevBelt subscription',
      product_code: 'FAST_INSTANT_TRADE_PAY',
      timeout_express: timeoutExpress(input.expiresTime),
    };
    const params: Record<string, string> = {
      app_id: this.creds.appId,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: alipayTimestamp(),
      version: '1.0',
      notify_url: this.creds.callbackUrl,
      biz_content: JSON.stringify(biz),
    };
    const sign = this.sign(params);
    const body = this.toFormBody({ ...params, sign });
    // 页面支付：直接返回签名表单的跳转 URL 供浏览器导航，不做 server 端 POST
    // （避免额外外部副作用 + 失败模式）。
    return { redirectUrl: `${ALIPAY_ORDER_URL}?${body}` };
  }

  verifyCallback(rawBody: Buffer, _headers: Record<string, string>): boolean {
    let form: Record<string, string>;
    try {
      form = this.parseForm(rawBody.toString('utf8'));
    } catch {
      return false;
    }
    const sign = form.sign;
    if (!sign) return false;
    // §54 防重放：支付宝异步通知时间字段为 `yyyy-MM-dd HH:mm:ss`（Asia/Shanghai），
    // 不能用 host-local Date.parse 解析；按 +08:00 显式解析。
    // §54 防重放：通知时间字段均缺失时 fail-closed（不能空值放行绕过新鲜度，P1）。
    const timestamp = form.notify_time ?? form.gmt_payment;
    if (!timestamp) return false;
    const ts = parseAlipayTime(timestamp);
    if (ts === null) return false;
    if (Math.abs(Date.now() - ts) > AlipayGateway.FRESHNESS_WINDOW_MS) return false;
    const content = buildAlipaySignContent(form);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(content);
    return verifier.verify(this.creds.alipayPublicKey, sign, 'base64');
  }

  parseCallback(rawBody: Buffer): PaymentCallback {
    const form = this.parseForm(rawBody.toString('utf8'));
    // 身份绑定：回调的 app_id 必须与配置一致，否则视为解析失败（P1）。
    if (form.app_id !== this.creds.appId) throw new PaymentCallbackInvalidError('alipay callback identity mismatch');
    const orderNo = form.out_trade_no;
    const tradeNo = form.trade_no;
    if (!orderNo || !tradeNo) throw new PaymentCallbackInvalidError('alipay callback missing trade fields');
    return {
      orderNo,
      channelTradeNo: tradeNo,
      amountCents: centsFromYuan(form.total_amount ?? ''),
      status: form.trade_status === 'TRADE_SUCCESS' || form.trade_status === 'TRADE_FINISHED' ? 'success' : 'failure',
      // 脱敏摘要：仅白名单字段落库 notify_summary，绝不存完整表单（P1 敏感信息边界）。
      summary: alipaySummary(form),
    };
  }

  private sign(params: Record<string, string>): string {
    // 请求签名：sign_type 参与签名（官方请求签名口径，只在验签侧排除）。
    const content = buildAlipaySignContent(params, { includeSignType: true });
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    return signer.sign(this.creds.appPrivateKey, 'base64');
  }

  private toFormBody(params: Record<string, string>): string {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  private parseForm(body: string): Record<string, string> {
    const params = new URLSearchParams(body);
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  }
}