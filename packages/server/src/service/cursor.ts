import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * 分页 cursor 编解码（P3 §6：不透明 + 服务端签名，前端不得解析/拼装）。
 *
 * 形态：`<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`。密钥由 Ed25519
 * signing key（TOKEN_SIGNING_KEY_B64）确定性派生，零新增部署变量。签名失败 /
 * 形态非法统一返回 null（由调用方回 422 INVALID_CURSOR）。
 */
export class CursorService {
  constructor(private readonly key: Buffer) {}

  encode(payload: string): string {
    const b64 = Buffer.from(payload, 'utf8').toString('base64url');
    return `${b64}.${this.mac(b64)}`;
  }

  /** 解码并验签；非法/篡改返回 null。 */
  decode(token: string): string | null {
    if (!token) return null;
    const sep = token.lastIndexOf('.');
    if (sep <= 0) return null;
    const payloadB64 = token.slice(0, sep);
    const mac = token.slice(sep + 1);
    const expected = this.mac(payloadB64);
    if (mac.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      return Buffer.from(payloadB64, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}

/** 从 Ed25519 signing key（基 64 PEM）确定性派生 cursor HMAC 密钥。 */
export function deriveCursorKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const b64 = (env.TOKEN_SIGNING_KEY_B64 || '').trim();
  if (!b64) throw new Error('TOKEN_SIGNING_KEY_B64 is required to derive the cursor signing key');
  return createHash('sha256').update(`dbclient:cursor:${b64}`).digest();
}