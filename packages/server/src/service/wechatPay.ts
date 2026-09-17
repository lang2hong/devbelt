import { createDecipheriv, createSign, createVerify, randomBytes } from 'crypto';
import type { PaymentGateway, PrepayParams, PaymentCallback } from './paymentChannel.js';
import type { WechatCredentials } from './paymentCredentials.js';
import { PaymentCallbackInvalidError } from '../domain/errors.js';

/**
 * 微信支付（API v3 Native）适配器（P4 切片 4B）。
 *
 * - 下单：构造 v3 Native 下单请求，用商户私钥对 `method\nurl\ntimestamp\nnonce\nbody\n`
 *   做 RSA-SHA256 签名，经注入 `fetchImpl` 发往渠道，返回 `code_url`。
 * - 回调验签：对 `timestamp\nnonce\nbody\n` 用平台证书（RSA-SHA256）验签。
 * - 回调解析：用 APIv3 key 对密文 AES-256-GCM 解密后归一化。
 *
 * 真实到微信沙箱的端到端联调属部署后人工验收（§83/§84）；本适配器的密码学逻辑用
 * 测试密钥可离线验证，真实 HTTP 由 `fetchImpl` 注入以便测试 stub。
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

/** API 绝对地址（仅作 fetch 目标）。 */
const NATIVE_ORDER_URL = 'https://api.mch.weixin.qq.com/v3/pay/transactions/native';
/** v3 请求签名使用的 canonical URI（不含 scheme/host，§请求签名规范）。 */
const NATIVE_CANONICAL_PATH = '/v3/pay/transactions/native';
/** 下单 HTTP 超时：渠道不响应时不能无限挂起请求处理。 */
const DEFAULT_ORDER_TIMEOUT_MS = 10_000;

export class WechatPayGateway implements PaymentGateway {
  readonly channel = 'wechat' as const;

  /** 回调时间戳新鲜度窗口（§54 防重放）：±5 分钟。 */
  static readonly FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

  constructor(
    private readonly creds: WechatCredentials,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly orderTimeoutMs: number = DEFAULT_ORDER_TIMEOUT_MS,
  ) {}

  /** 微信 Native 下单：仅扫码（返回 code_url），故忽略 `mode`（接口允许但其语义不适用）。 */
  async createPayment(input: { orderNo: string; amountCents: number; expiresTime: Date }): Promise<PrepayParams> {
    const body = JSON.stringify({
      appid: this.creds.appId,
      mchid: this.creds.mchId,
      description: 'DevKit subscription',
      out_trade_no: input.orderNo,
      time_expire: input.expiresTime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      amount: { total: input.amountCents, currency: 'CNY' },
      notify_url: this.creds.callbackUrl,
    });
    const { signature, timestamp, nonce } = this.signRequest('POST', NATIVE_CANONICAL_PATH, body);

    const res = await this.fetchImpl(NATIVE_ORDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.authorizationHeader(timestamp, nonce, signature),
      },
      body,
      signal: AbortSignal.timeout(this.orderTimeoutMs),
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error('wechat native order timed out');
      }
      throw err;
    });
    if (!res.ok) {
      throw new Error(`wechat native order failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { code_url?: string };
    if (!json.code_url) throw new Error('wechat native order returned no code_url');
    return { codeUrl: json.code_url };
  }

  verifyCallback(rawBody: Buffer, headers: Record<string, string>): boolean {
    const timestamp = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const signature = headers['wechatpay-signature'];
    const serial = headers['wechatpay-serial'];
    if (!timestamp || !nonce || !signature) return false;

    // 平台证书序列号绑定：入站 serial 必须等于配置的平台证书 serial（防证书轮换期错配）。
    if (this.creds.platformCertSerial && serial !== this.creds.platformCertSerial) return false;

    // §54 防重放：时间戳必须落在 ±5min 新鲜度窗口内。
    const ts = Number(timestamp);
    if (!Number.isInteger(ts)) return false;
    const drift = Math.abs(Date.now() - ts * 1000);
    if (drift > WechatPayGateway.FRESHNESS_WINDOW_MS) return false;

    const message = `${timestamp}\n${nonce}\n${rawBody.toString('utf8')}\n`;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(message);
    return verifier.verify(this.creds.platformPublicKey, signature, 'base64');
  }

  parseCallback(rawBody: Buffer): PaymentCallback {
    // v3 回调体：{ resource: { ciphertext, nonce, associated_data } }，AES-256-GCM 解密。
    const envelope = JSON.parse(rawBody.toString('utf8')) as {
      resource?: { ciphertext?: string; nonce?: string; associated_data?: string };
    };
    const r = envelope.resource;
    if (!r || !r.ciphertext || !r.nonce) throw new PaymentCallbackInvalidError('wechat callback missing resource');
    const plain = this.decryptResource(r.ciphertext, r.nonce, r.associated_data ?? '');
    const data = JSON.parse(plain) as {
      appid?: string;
      mchid?: string;
      out_trade_no?: string;
      transaction_id?: string;
      amount?: { total?: number };
      trade_state?: string;
      success_time?: string;
    };
    // 身份绑定：解密后的 appid/mchid 必须与配置一致，否则视为解析失败（P1）。
    if (data.appid !== this.creds.appId || data.mchid !== this.creds.mchId) {
      throw new PaymentCallbackInvalidError('wechat callback identity mismatch');
    }
    if (!data.out_trade_no || !data.transaction_id) throw new PaymentCallbackInvalidError('wechat callback missing trade fields');
    const summary: Record<string, string> = {
      appid: data.appid,
      mchid: data.mchid,
      out_trade_no: data.out_trade_no,
      transaction_id: data.transaction_id,
      total: String(data.amount?.total ?? 0),
      trade_state: data.trade_state ?? '',
    };
    if (data.success_time) summary.success_time = data.success_time;
    return {
      orderNo: data.out_trade_no,
      channelTradeNo: data.transaction_id,
      amountCents: data.amount?.total ?? 0,
      status: data.trade_state === 'SUCCESS' ? 'success' : 'failure',
      // 脱敏摘要：仅白名单字段落库 notify_summary，绝不存完整加密信封（P1 敏感信息边界）。
      summary,
    };
  }

  private decryptResource(ciphertext: string, nonce: string, associatedData: string): string {
    const ct = Buffer.from(ciphertext, 'base64');
    const tag = ct.subarray(ct.length - 16);
    const body = ct.subarray(0, ct.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.creds.apiV3Key, Buffer.from(nonce));
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  private signRequest(method: string, url: string, body: string): { signature: string; timestamp: string; nonce: string } {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`;
    const signer = createSign('RSA-SHA256');
    signer.update(message);
    const signature = signer.sign(this.creds.merchantPrivateKey, 'base64');
    return { signature, timestamp, nonce };
  }

  private authorizationHeader(timestamp: string, nonce: string, signature: string): string {
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.creds.mchId}",` +
      `nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.creds.merchantCertSerial}",signature="${signature}"`
    );
  }
}