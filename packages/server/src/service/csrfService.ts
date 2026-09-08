import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * 匿名 CSRF 服务（P3 §4.2 双提交模式，切片 1 的匿名 bootstrap）。
 *
 * 切片 1 只签发匿名 CSRF token 并做双提交校验：cookie 与 `X-CSRF-Token` 头常量时间相等。
 * token 为 256-bit 随机值，无法被跨站攻击者读出或预置，天然满足「非登录写请求须携带
 * 可由 JS 读取的 token」需求。会话绑定（token 与 sessionId 挂钩）由切片 2 升级。
 */
export class CsrfService {
  /** 生成一个新的匿名 CSRF token（写入非 HttpOnly cookie，由前端回显到请求头）。 */
  issue(): string {
    return randomBytes(32).toString('base64url');
  }

  /** 双提交校验：cookie 值与请求头值常量时间比较。任一缺失或不等即失败。 */
  verify(cookieValue: string | undefined, headerValue: string | undefined): boolean {
    if (!cookieValue || !headerValue) return false;
    const a = Buffer.from(cookieValue, 'utf8');
    const b = Buffer.from(headerValue, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}