import { createHmac, timingSafeEqual } from 'crypto';
import type { PaymentChannel } from '../../../domain/enums.js';
import { resolveWechatCredentials, resolveAlipayCredentials } from './paymentCredentials.js';
import { resolveFeatureFlags } from '../../../service/featureFlags.js';
import { WechatPayGateway } from './wechatPay.js';
import { AlipayGateway } from './alipay.js';

/**
 * 支付渠道抽象（P4 §金额与安全）。
 *
 * ## fail-closed（P0/P4 §68）
 * 真实渠道凭据经 env 注入（微信 `WECHAT_*`、支付宝 `ALIPAY_*`）；`resolvePaymentGateway`
 * 在凭据缺失时抛错，`paymentGatewayConfigured` 仅在至少一个渠道凭据齐全时为 true——
 * 未配置渠道的任何运行实例都不装配支付回调，绝不暴露可伪造/弱路径。内存 stub
 * 只供测试直接依赖注入，绝不进组合根。
 */

/** 下单返回给前端/扩展的支付参数：仅白名单字段，防止适配器回传多余数据外泄给客户端。 */
export interface PrepayParams {
  /** 扫码模式：二维码内容/链接。 */
  codeUrl?: string;
  /** 跳转模式：收银台 URL。 */
  redirectUrl?: string;
}

/** 边界白名单：只透出 codeUrl/redirectUrl，忽略适配器可能附加的其它字段。 */
export function clientPayParams(params: PrepayParams): PrepayParams {
  const out: PrepayParams = {};
  if (typeof params.codeUrl === 'string') out.codeUrl = params.codeUrl;
  if (typeof params.redirectUrl === 'string') out.redirectUrl = params.redirectUrl;
  return out;
}

/** 回调解析后的归一化交易信息（校验通过后由 parse 产出）。 */
export interface PaymentCallback {
  orderNo: string;
  channelTradeNo: string;
  /** 回调声称的实付金额（分），服务层必须与订单金额复核。 */
  amountCents: number;
  /** 渠道侧交易结果。failure 表示支付失败/关闭，不推进为 paid。 */
  status: 'success' | 'failure';
  /** 渠道白名单脱敏摘要（仅允许字段），落库 notify_summary（payments.notify_summary）；不含原始信封/表单。 */
  summary?: Record<string, string>;
}

/**
 * 支付渠道适配器。`verifyCallback` 校验渠道签名（签名必须绑定回调**原始字节**，
 * 用 Buffer 而非 string，避免 chunk 边界破坏多字节 UTF-8 / 非 UTF-8 协议），
 * `parseCallback` 在验签**通过后**按渠道协议解码。
 */
export interface PaymentGateway {
  readonly channel: PaymentChannel;
  /** 向渠道发起预下单，返回支付参数（二维码/跳转链接等）。`expiresTime` 为权威本地过期时刻，渠道据此设置外部支付有效期，避免「本地过期后仍可付款但无权益」。
   *  `mode`：`qr`=扫码（返回 codeUrl），`redirect`=跳转收银台（返回 redirectUrl）；缺省由渠道自定。 */
  createPayment(input: { orderNo: string; amountCents: number; expiresTime: Date; mode?: 'qr' | 'redirect' }): Promise<PrepayParams>;
  /** 校验回调签名。false = 拒绝（服务层抛 PAYMENT_SIGNATURE_INVALID）。 */
  verifyCallback(rawBody: Buffer, headers: Record<string, string>): boolean;
  /** 验签通过后解析归一化交易信息。 */
  parseCallback(rawBody: Buffer): PaymentCallback;
}

/** 内存 stub 的 HMAC 密钥（仅测试用）。 */
const MEMORY_GATEWAY_KEY = 'devbelt.memory-payment-gateway.test-only';

/** 内存 stub 回调签名：HMAC-SHA256 over 原始回调字节（供测试构造合法回调）。 */
export function signMemoryCallback(rawBody: Buffer): string {
  return createHmac('sha256', MEMORY_GATEWAY_KEY).update(rawBody).digest('hex');
}

/**
 * 内存 stub 渠道（切片 2 专用，仅供测试直接依赖注入）。签名基于原始回调字节的
 * HMAC-SHA256，通过 `x-payment-signature` 头回传；回调 body 为 JSON
 * `{ orderNo, channelTradeNo, amountCents, status }`。
 */
export class MemoryPaymentGateway implements PaymentGateway {
  constructor(readonly channel: PaymentChannel) {}

  async createPayment(input: { orderNo: string; amountCents: number; expiresTime: Date; mode?: 'qr' | 'redirect' }): Promise<PrepayParams> {
    // stub：qr 模式返回 code_url，redirect 模式返回跳转链接；缺省按渠道（微信默认扫码、支付宝默认跳转）。
    const mode = input.mode ?? (this.channel === 'wechat' ? 'qr' : 'redirect');
    return mode === 'qr'
      ? { codeUrl: this.channel === 'wechat' ? 'weixin://wxpay/mock-code-url' : 'https://openapi.alipay.com/mock-qr' }
      : { redirectUrl: this.channel === 'wechat' ? 'https://wx.tenpay.com/mock-h5-redirect' : 'https://openapi.alipay.com/mock-redirect' };
  }

  verifyCallback(rawBody: Buffer, headers: Record<string, string>): boolean {
    const provided = headers['x-payment-signature'];
    if (!provided) return false;
    const expected = signMemoryCallback(rawBody);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseCallback(rawBody: Buffer): PaymentCallback {
    return JSON.parse(rawBody.toString('utf8')) as PaymentCallback;
  }
}

/** 返回配置齐全的渠道集合（每个渠道单独判定，供路由做 fail-closed 拒绝）。 */
export function resolveConfiguredChannels(env: NodeJS.ProcessEnv = process.env): ReadonlySet<PaymentChannel> {
  const set = new Set<PaymentChannel>();
  if (resolveWechatCredentials(env) !== undefined) set.add('wechat');
  if (resolveAlipayCredentials(env) !== undefined) set.add('alipay');
  return set;
}

/** 支付渠道是否已装配（至少一个渠道凭据齐全）。 */
export function paymentGatewayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConfiguredChannels(env).size > 0;
}

/**
 * 支付路由是否应注册（opt-in）：凭据齐全 **且** 显式 `FEATURE_PAYMENT=true/1/on`。
 * 仅配凭据而缺开关视为关闭——资金面集成中「配凭据」与「开启客户支付」是两次独立上线动作。
 */
export function paymentRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return paymentGatewayConfigured(env) && resolveFeatureFlags(env).enabled('payment');
}

/** 某渠道是否已配置（供路由在调用前做 503 拒绝，而非落 generic 异常路径）。 */
export function isChannelConfigured(channel: PaymentChannel, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConfiguredChannels(env).has(channel);
}

/** 按渠道装配适配器。凭据缺失 fail-closed：无真实适配器就抛错。 */
export function resolvePaymentGateway(
  channel: PaymentChannel,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>,
): PaymentGateway {
  if (channel === 'wechat') {
    const creds = resolveWechatCredentials(env);
    if (!creds) {
      throw new Error('wechat payment gateway is not configured; provide WECHAT_* credentials (P4 slice 4)');
    }
    return new WechatPayGateway(creds, fetchImpl as never);
  }
  const creds = resolveAlipayCredentials(env);
  if (!creds) {
    throw new Error('alipay payment gateway is not configured; provide ALIPAY_* credentials (P4 slice 4)');
  }
  return new AlipayGateway(creds, fetchImpl as never);
}

/** 支持的全部渠道。 */
export const PAYMENT_CHANNELS: readonly PaymentChannel[] = ['wechat', 'alipay'];