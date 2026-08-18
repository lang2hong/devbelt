import { describe, expect, it } from 'vitest';
import { parseTokenTtl } from '../src/config.js';

/**
 * Token 有效期的上限约束。
 *
 * access token 是承载全部权限的 bearer 凭据，且没有设备/IP 绑定 —— 日志、崩溃
 * 报告、代理、剪贴板任一处泄漏就等于把访问权交出去。它的有效期越长，泄漏到被
 * 发现之间的窗口越大。
 *
 * 原实现把 `ACCESS_TOKEN_EXPIRES_IN` 原样透传给 fast-jwt，不做任何校验，于是：
 *  - 代码注释、限流阈值推导、会话吊销测试全部建立在「15 分钟」这个前提上，
 *    而本仓库实际配的是 `7d`（672 倍）；
 *  - fast-jwt 内部用 @lukeed/ms 解析，`'900'` 会被当成 **900 毫秒**（按
 *    jsonwebtoken 的「数字=秒」直觉写就中招），`'abc'` 则让每次签发抛错 → 全部 500。
 *
 * 所以这里在启动时就把两个时长解析并校验掉，非法值启动即失败，而不是留到运行时
 * 变成「登录全挂」或「token 0.9 秒就过期」。
 */
describe('parseTokenTtl', () => {
  it('接受 \\d+[smh] 并返回毫秒', () => {
    expect(parseTokenTtl('30s', 'X', 3_600_000)).toEqual({ raw: '30s', ms: 30_000 });
    expect(parseTokenTtl('15m', 'X', 3_600_000)).toEqual({ raw: '15m', ms: 900_000 });
    expect(parseTokenTtl('1h', 'X', 3_600_000)).toEqual({ raw: '1h', ms: 3_600_000 });
  });

  it('接受 d 单位（refresh token 需要）', () => {
    expect(parseTokenTtl('30d', 'X', 90 * 86400_000).ms).toBe(30 * 86400_000);
  });

  it('超过上限抛错', () => {
    // 7d 远超 access token 的 1h 上限 —— 这正是修复前的实际配置
    expect(() => parseTokenTtl('7d', 'ACCESS_TOKEN_EXPIRES_IN', 3_600_000))
      .toThrow(/ACCESS_TOKEN_EXPIRES_IN/);
    expect(() => parseTokenTtl('2h', 'ACCESS_TOKEN_EXPIRES_IN', 3_600_000))
      .toThrow(/exceeds/i);
  });

  it('恰好等于上限通过（边界含等号）', () => {
    expect(parseTokenTtl('1h', 'X', 3_600_000).ms).toBe(3_600_000);
  });

  it('纯数字被拒绝（避免 900 被当成 900 毫秒）', () => {
    // fast-jwt 的 @lukeed/ms 会把 '900' 解析成 900ms；按 jsonwebtoken 的
    // 「数字=秒」直觉配置的人会得到一个 0.9 秒就过期的 token
    expect(() => parseTokenTtl('900', 'X', 3_600_000)).toThrow(/must match/i);
  });

  it('非法格式被拒绝（而不是静默回落）', () => {
    for (const bad of ['abc', '15min', '', '-5m', '1.5h', '15 m']) {
      expect(() => parseTokenTtl(bad, 'X', 3_600_000), `应拒绝 ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('0 被拒绝（签发即过期的 token 毫无意义）', () => {
    expect(() => parseTokenTtl('0m', 'X', 3_600_000)).toThrow();
  });

  it('错误信息包含变量名，便于定位是哪一个配置写错了', () => {
    expect(() => parseTokenTtl('abc', 'REFRESH_TOKEN_EXPIRES_IN', 1000))
      .toThrow(/REFRESH_TOKEN_EXPIRES_IN/);
  });
});
