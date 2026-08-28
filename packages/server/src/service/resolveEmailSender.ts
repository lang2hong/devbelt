import { LogEmailSender, type EmailSender } from './emailSender.js';
import { SmtpEmailSender } from './smtpEmailSender.js';

/**
 * 按环境选择 EmailSender（实施规格 §4.7）。
 *
 * - production：必须配置 SMTP，否则验证邮件无法投递 —— 启动即失败。
 * - 非 production（开发/测试）：**固定** LogEmailSender，绝不向真实地址发信
 *   （即使设置了 SMTP_HOST 也不启用真实 SMTP；需要 Mailpit/MailHog 请用专门的
 *   本地发送器，而不是通用 SMTP sender）。
 *
 * 独立成模块以便测试（app.ts 的 import 会触发 config 顶层求值，不便单独断言）。
 */
export function resolveEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  if (env.NODE_ENV === 'production') {
    if (!env.SMTP_HOST || !env.SMTP_HOST.trim()) {
      throw new Error(
        'SMTP_HOST is required in production: verification emails cannot be left to a stub sender.',
      );
    }
    return new SmtpEmailSender(env);
  }
  return new LogEmailSender();
}