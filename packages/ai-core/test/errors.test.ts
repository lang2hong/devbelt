import { describe, expect, it } from 'vitest';
import {
  AiAbortError,
  AiAuthError,
  AiError,
  AiNetworkError,
  AiProtocolError,
  AiQuotaExceededError,
  AiRateLimitedError,
  AiTimeoutError,
} from '../src/errors.js';

/**
 * 错误码契约冻结（P9 S6）：UI/审计按 `code` 做稳定分支，不依赖 message 文本。
 * 任何修改 code 字符串都视为破坏性变更，必须在此显式同步。
 */
describe('AI 错误码契约（code/name 冻结）', () => {
  it('每个错误类的 code 与 name 稳定', () => {
    expect(new AiAuthError()).toMatchObject({ code: 'AI_AUTH_ERROR', name: 'AiAuthError' });
    expect(new AiRateLimitedError()).toMatchObject({ code: 'AI_RATE_LIMITED', name: 'AiRateLimitedError' });
    expect(new AiQuotaExceededError()).toMatchObject({ code: 'AI_QUOTA_EXCEEDED', name: 'AiQuotaExceededError' });
    expect(new AiNetworkError('x')).toMatchObject({ code: 'AI_NETWORK_ERROR', name: 'AiNetworkError' });
    expect(new AiTimeoutError()).toMatchObject({ code: 'AI_TIMEOUT', name: 'AiTimeoutError' });
    expect(new AiAbortError()).toMatchObject({ code: 'AI_ABORTED', name: 'AiAbortError' });
    expect(new AiProtocolError()).toMatchObject({ code: 'AI_PROTOCOL_ERROR', name: 'AiProtocolError' });
    // 客户端路由错误共用基类 code（AI_NOT_CONFIGURED 由 vscode-ext 侧使用）
    expect(new AiError('AI_NOT_CONFIGURED', 'x')).toMatchObject({ code: 'AI_NOT_CONFIGURED', name: 'AiError' });
  });

  it('附带字段保留：quota 上下文 / retryAfterMs / network status / cause', () => {
    const quota = new AiQuotaExceededError({ limit: 100, used: 100, reserved: 0, resetAt: '2026-11-01' });
    expect(quota.quota).toEqual({ limit: 100, used: 100, reserved: 0, resetAt: '2026-11-01' });

    expect(new AiRateLimitedError(2000).retryAfterMs).toBe(2000);
    expect(new AiNetworkError('boom', 503).status).toBe(503);

    const cause = new Error('underlying');
    const wrapped = new AiNetworkError('boom', undefined, cause);
    expect(wrapped.cause).toBe(cause);
  });

  it('全部错误都是 AiError 实例（统一 catch 分支）', () => {
    const errors = [
      new AiAuthError(),
      new AiRateLimitedError(),
      new AiQuotaExceededError(),
      new AiNetworkError('x'),
      new AiTimeoutError(),
      new AiAbortError(),
      new AiProtocolError(),
    ];
    for (const error of errors) expect(error).toBeInstanceOf(AiError);
  });
});