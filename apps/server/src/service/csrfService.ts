import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * CSRF 服务（P3 §4.2 签名双提交）。
 *
 * 切片 2 升级（N4）：匿名引导 + HMAC 签名 + 会话绑定。token 形态：
 *   `[<binding>.]<nonce>.<goal>:<mac>`，mac = HMAC-SHA256(key, payload)。
 * - 匿名（binding 缺省）：只校验签名 + cookie↔header 双提交恒等。
 * - 会话绑定（binding = sessionId）：额外校验 token 携带的 binding 与当前会话一致。
 *
 * 签名密钥由 signing key（TOKEN_SIGNING_KEY_B64）派生，不新增部署变量。
 */
export class CsrfService {
  constructor(private readonly key: Buffer) {}

  /** 签发新 token。binding 给定时绑定到该会话 id。 */
  issue(binding?: string): string {
    const nonce = randomBytes(32).toString('base64url');
    const payload = binding ? `${binding}.${nonce}` : nonce;
    return `${payload}.${this.mac(payload)}`;
  }

  /**
   * 双提交校验：cookie 与 header 恒等 + 签名合法（+ 会话绑定）。
   * `binding` 给定时要求 token 的 binding 段等于它（§4.2 规则 2）。
   */
  verify(cookieValue: string | undefined, headerValue: string | undefined, binding?: string): boolean {
    if (!cookieValue || !headerValue || cookieValue !== headerValue) return false;
    return this.verifySigned(cookieValue, binding);
  }

  /** 仅校验 token 签名（+可选会话绑定），不要求双提交（供已有匿名/其它路径复用）。 */
  verifySigned(tokenValue: string, binding?: string): boolean {
    const sep = tokenValue.lastIndexOf('.');
    if (sep <= 0) return false;
    const payload = tokenValue.slice(0, sep);
    const mac = tokenValue.slice(sep + 1);
    const expected = this.mac(payload);
    if (mac.length !== expected.length) return false;
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
    if (binding !== undefined) {
      const bound = payload.slice(0, payload.indexOf('.'));
      if (bound !== binding) return false;
    }
    return true;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}

/** 从 Ed25519 signing key（基 64 PEM）确定性派生 CSRF HMAC 密钥（零新增部署变量）。 */
export function deriveCsrfKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const b64 = (env.TOKEN_SIGNING_KEY_B64 || '').trim();
  if (!b64) {
    throw new Error('TOKEN_SIGNING_KEY_B64 is required to derive the CSRF signing key');
  }
  return createHash('sha256').update(`devbelt:csrf:${b64}`).digest();
}