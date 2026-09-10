import { createHmac, timingSafeEqual } from 'crypto';
import type { PaymentChannel } from '../domain/enums.js';

/**
 * 支付渠道抽象（P4 §金额与安全）。真实微信/支付宝适配器在切片 4 落地，本切片
 * 只交付接口 + 内存 stub，使下单/回调/权益生效全程可离线单测、可 CI 验证，
 * 不接触真实资金、不加载商户证书/密钥。
 *
 * ## fail-closed（P0）
 * 支付入口默认关闭。`resolvePaymentGateway` 在切片 2 **无条件抛错**——真实
 * WeChat/Alipay 适配器属切片 4，落地并注入商户凭据前，任何运行实例都不得装配
 * 可伪造的支付回调。内存 stub 只供测试直接依赖注入，绝不进组合根。
 */

/** 下单返回给前端/扩展的支付参数（微信扫码 code_url / 支付宝跳转 url 等）。 */
export interface PrepayParams {
  [key: string]: unknown;
}

/** 回调解析后的归一化交易信息（校验通过后由 parse 产出）。 */
export interface PaymentCallback {
  orderNo: string;
  channelTradeNo: string;
  /** 回调声称的实付金额（分），服务层必须与订单金额复核。 */
  amountCents: number;
  /** 渠道侧交易结果。failure 表示支付失败/关闭，不推进为 paid。 */
  status: 'success' | 'failure';
}

/**
 * 支付渠道适配器。`verifyCallback` 校验渠道签名（签名必须绑定回调**原始字节**，
 * 用 Buffer 而非 string，避免 chunk 边界破坏多字节 UTF-8 / 非 UTF-8 协议），
 * `parseCallback` 在验签**通过后**按渠道协议解码。
 */
export interface PaymentGateway {
  readonly channel: PaymentChannel;
  /** 向渠道发起预下单，返回支付参数（二维码/跳转链接等）。 */
  createPayment(input: { orderNo: string; amountCents: number }): Promise<PrepayParams>;
  /** 校验回调签名。false = 拒绝（服务层抛 PAYMENT_SIGNATURE_INVALID）。 */
  verifyCallback(rawBody: Buffer, headers: Record<string, string>): boolean;
  /** 验签通过后解析归一化交易信息。 */
  parseCallback(rawBody: Buffer): PaymentCallback;
}

/** 内存 stub 的 HMAC 密钥（仅测试用）。 */
const MEMORY_GATEWAY_KEY = 'dbclient.memory-payment-gateway.test-only';

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

  async createPayment(input: { orderNo: string; amountCents: number }): Promise<PrepayParams> {
    return {
      orderNo: input.orderNo,
      amountCents: input.amountCents,
      channel: this.channel,
      mock: this.channel === 'wechat' ? 'weixin://wxpay/mock-code-url' : 'https://openapi.alipay.com/mock-redirect',
    };
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

/** 支付渠道是否已装配（切片 2 恒 false：真实适配器未落地）。 */
export function paymentGatewayConfigured(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

/** 按渠道装配适配器。切片 2 无条件 fail-closed（无真实适配器）。 */
export function resolvePaymentGateway(_channel: PaymentChannel, _env: NodeJS.ProcessEnv = process.env): PaymentGateway {
  throw new Error('payment gateway is not configured; a real WeChat/Alipay adapter is required (P4 slice 4)');
}

/** 支持的全部渠道。 */
export const PAYMENT_CHANNELS: readonly PaymentChannel[] = ['wechat', 'alipay'];