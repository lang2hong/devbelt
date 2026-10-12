import { AiError } from '@devbelt/ai-core';

/**
 * 客户端 AI 路由错误（P9 S3）。
 *
 * 与 ai-core 的传输层错误（AiAuthError/AiRateLimitedError/…）并列，用于
 * "还没发请求就不满足前置条件"的两类情况：未配置 Key / 服务端代理未登录。
 * UI 依 code 分支给出「去设置」/「去登录」的引导。
 */

/** 自带 Key 模式未配置 baseUrl/model/apiKey → 提示去设置。 */
export class AiNotConfiguredError extends AiError {
  constructor(message = 'AI provider is not configured') {
    super('AI_NOT_CONFIGURED', message);
  }
}

/** 服务端代理模式未登录（v1 不做匿名代理）→ 提示登录或切换自带 Key。 */
export class AiLoginRequiredError extends AiError {
  constructor(message = 'login required for the server proxy') {
    super('AI_LOGIN_REQUIRED', message);
  }
}