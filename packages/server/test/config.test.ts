import { describe, expect, it } from 'vitest';
import { resolveJwtSecret } from '../src/config.js';

/**
 * JWT_SECRET 的强度门禁。
 *
 * 这个密钥是整套认证的根：拿到它就能自签任意 access token，包括 role=admin 的。
 * 会话校验（requireAuth 的 getSession）挡不住自签 token —— refresh_tokens.id 是
 * 自增整数，攻击者对目标用户遍历 sid=1..N 就能凑出一条能过校验的 token。
 *
 * 原实现只判「生产环境下密钥是否存在」，不判取值。两条真实可达的路径让这道
 * 检查失效：
 *
 *  1. docker compose 里写着 `JWT_SECRET: ${JWT_SECRET:-change-me-in-prod}`。
 *     Dockerfile 设了 NODE_ENV=production，本以为「生产必填」会兜住，但 compose
 *     自己提供了默认值 —— process.env.JWT_SECRET 恒非空，必填检查被绕过，
 *     服务以仓库里公开可见的字符串签名，启动日志毫无提示。
 *  2. 裸进程（systemd / pm2）不设 NODE_ENV 时，静默回落到 'dev-secret-change-me'，
 *     同样是公开值。
 *
 * 因此生产环境必须拒绝：缺失、已知弱值、以及长度不足的密钥。
 *
 * 非生产环境只告警不抛错 —— 开发机上的弱密钥不该阻断启动，而且抛错会让
 * 任何 import 了 config 的测试直接挂掉。
 */
describe('resolveJwtSecret（生产环境）', () => {
  const PROD = 'production';

  it('缺失时抛错', () => {
    expect(() => resolveJwtSecret(undefined, PROD)).toThrow(/JWT_SECRET/);
    expect(() => resolveJwtSecret('', PROD)).toThrow(/JWT_SECRET/);
  });

  it('拒绝 docker-compose 的默认值 change-me-in-prod', () => {
    // 这是最容易真的打到生产的一条：用户没填 .env，compose 默认值顶上
    expect(() => resolveJwtSecret('change-me-in-prod', PROD)).toThrow(/well-known default/i);
  });

  it('拒绝代码里的开发回落值 dev-secret-change-me', () => {
    expect(() => resolveJwtSecret('dev-secret-change-me', PROD)).toThrow(/well-known default/i);
  });

  it('弱值判定忽略大小写与首尾空白', () => {
    expect(() => resolveJwtSecret('  Change-Me-In-Prod  ', PROD)).toThrow(/well-known default/i);
  });

  it('拒绝长度不足 32 的密钥', () => {
    expect(() => resolveJwtSecret('a'.repeat(31), PROD)).toThrow(/at least 32/i);
  });

  it('接受长度足够且非弱值的密钥，并去掉首尾空白', () => {
    const strong = 'K7f9Qs2mZx4Lp8Vn6Tb3Rw1Yc5Hj0Ge9Ud';
    expect(resolveJwtSecret(strong, PROD)).toBe(strong);
    expect(resolveJwtSecret(`  ${strong}  `, PROD)).toBe(strong);
  });

  it('恰好 32 位通过（边界含等号）', () => {
    const s = 'b'.repeat(32);
    expect(resolveJwtSecret(s, PROD)).toBe(s);
  });

  it('错误信息提示轮换会影响旧 sha256 用户', () => {
    // 旧密码哈希的盐取自 JWT_SECRET，换密钥等于让那批用户再也登不上。
    // 运维必须在换密钥之前知道这件事，所以写进错误信息里。
    expect(() => resolveJwtSecret('short', PROD)).toThrow(/legacy/i);
  });
});

describe('resolveJwtSecret（非生产环境）', () => {
  it('缺失时回落到开发密钥且不抛错', () => {
    expect(resolveJwtSecret(undefined, 'development')).toBe('dev-secret-change-me');
    expect(resolveJwtSecret(undefined, undefined)).toBe('dev-secret-change-me');
  });

  it('弱值与短密钥照常放行（开发机不该被阻断）', () => {
    expect(resolveJwtSecret('change-me-in-prod', 'development')).toBe('change-me-in-prod');
    expect(resolveJwtSecret('short', undefined)).toBe('short');
  });

  it('test 环境同样不抛错', () => {
    expect(resolveJwtSecret('test-secret', 'test')).toBe('test-secret');
  });
});
