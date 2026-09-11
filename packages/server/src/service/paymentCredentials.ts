import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';

/**
 * 支付渠道商户凭据解析（P4 切片 4B，仿 signingKeys.ts 的纯函数约定）。
 *
 * 每个渠道要么「凭据齐全 + 回调 URL 合法」，要么「返回 undefined = 该渠道未配置」，
 * 绝不在半配状态下暴露弱路径。凭据全部 env 注入、不入仓库、不入库、不落日志。
 *
 * 回调 URL：支付是异步通知，渠道必须能把**非空**回调 URL 交给平台；URL 不合法时
 * 该渠道视为未配置（P0：空 notify_url 会导致已付款订单永不履约）。
 */

/** 解析支付回调基础 URL（HTTPS 裸 origin）。非法/缺失返回 undefined。 */
export function resolvePaymentCallbackBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.PAYMENT_CALLBACK_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (!url.hostname) return undefined;
  if (url.pathname !== '/') return undefined;
  return url.origin;
}

/** 微信支付（API v3 Native）所需凭据。 */
export interface WechatCredentials {
  mchId: string;
  appId: string;
  /** 商户证书序列号（16 进制），v3 Authorization 元数据必填。 */
  merchantCertSerial: string;
  /** 平台证书序列号（16 进制），回调验签绑定（防证书轮换期错配）。 */
  platformCertSerial: string;
  /** 商户私钥（RSA PKCS8 PEM）。 */
  merchantPrivateKey: KeyObject;
  /** 平台证书公钥（RSA SPKI PEM），用于回调验签。 */
  platformPublicKey: KeyObject;
  /** APIv3 key（严格 32 字节），AES-256-GCM 回调解密。 */
  apiV3Key: Buffer;
  /** 该渠道精确回调 URL。 */
  callbackUrl: string;
}

/** 支付宝（网页 H5）所需凭据。 */
export interface AlipayCredentials {
  appId: string;
  /** 应用私钥（RSA PKCS8 PEM）。 */
  appPrivateKey: KeyObject;
  /** 支付宝公钥（RSA SPKI PEM），用于回调验签。 */
  alipayPublicKey: KeyObject;
  /** 该渠道精确回调 URL。 */
  callbackUrl: string;
}

function decodePem(b64: string | undefined, varName: string): string {
  if (!b64) return '';
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN')) throw new Error(`${varName} does not decode to a PEM key`);
  return pem;
}

const HEX_SERIAL = /^[0-9a-fA-F]{4,64}$/;

/** 解析微信凭据；任一必需项缺失、或回调 URL/证书序列号/v3 key 非法 → undefined。 */
export function resolveWechatCredentials(env: NodeJS.ProcessEnv = process.env): WechatCredentials | undefined {
  const callbackBase = resolvePaymentCallbackBaseUrl(env);
  if (!callbackBase) return undefined;

  const mchId = (env.WECHAT_MCH_ID || '').trim();
  const appId = (env.WECHAT_APP_ID || '').trim();
  const serial = (env.WECHAT_MERCHANT_CERT_SERIAL || '').trim();
  const platformSerial = (env.WECHAT_PLATFORM_CERT_SERIAL || '').trim();
  const keyB64 = (env.WECHAT_PRIVATE_KEY_B64 || '').trim();
  const certB64 = (env.WECHAT_PLATFORM_CERT_B64 || '').trim();
  const apiV3 = (env.WECHAT_API_V3_KEY || '').trim();
  if (!mchId || !appId || !serial || !platformSerial || !keyB64 || !certB64 || !apiV3) return undefined;
  if (!HEX_SERIAL.test(serial)) return undefined;
  if (!HEX_SERIAL.test(platformSerial)) return undefined;

  // APIv3 key 必须严格 32 UTF-8 字节：不截断、不接受短/长值（P1-2）。
  const apiV3Key = Buffer.from(apiV3, 'utf8');
  if (apiV3Key.length !== 32) return undefined;

  return {
    mchId,
    appId,
    merchantCertSerial: serial,
    platformCertSerial: platformSerial,
    merchantPrivateKey: createPrivateKey({ key: decodePem(keyB64, 'WECHAT_PRIVATE_KEY_B64'), format: 'pem' }),
    platformPublicKey: createPublicKey({ key: decodePem(certB64, 'WECHAT_PLATFORM_CERT_B64'), format: 'pem' }),
    apiV3Key,
    callbackUrl: `${callbackBase}/api/public/payment-callback/wechat`,
  };
}

/** 解析支付宝凭据；任一必需项缺失、或回调 URL 非法 → undefined。 */
export function resolveAlipayCredentials(env: NodeJS.ProcessEnv = process.env): AlipayCredentials | undefined {
  const callbackBase = resolvePaymentCallbackBaseUrl(env);
  if (!callbackBase) return undefined;

  const appId = (env.ALIPAY_APP_ID || '').trim();
  const keyB64 = (env.ALIPAY_PRIVATE_KEY_B64 || '').trim();
  const pubB64 = (env.ALIPAY_PUBLIC_KEY_B64 || '').trim();
  if (!appId || !keyB64 || !pubB64) return undefined;

  return {
    appId,
    appPrivateKey: createPrivateKey({ key: decodePem(keyB64, 'ALIPAY_PRIVATE_KEY_B64'), format: 'pem' }),
    alipayPublicKey: createPublicKey({ key: decodePem(pubB64, 'ALIPAY_PUBLIC_KEY_B64'), format: 'pem' }),
    callbackUrl: `${callbackBase}/api/public/payment-callback/alipay`,
  };
}