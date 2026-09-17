import { LogEmailSender, type EmailSender } from './emailSender.js';
import { SmtpEmailSender } from './smtpEmailSender.js';

/**
 * 按环境选择 EmailSender（实施规格 §5.1）。
 *
 * - production：必须配置 SMTP，否则验证邮件无法投递 —— 启动即失败。
 * - 非 production（开发/测试）：**固定** LogEmailSender，绝不向真实地址发信
 *   （即使设置了 SMTP_HOST 也不启用真实 SMTP；需要 Mailpit/MailHog 请用专门的
 *   本地发送器，而不是通用 SMTP sender）。
 *
 * 独立成模块以便测试（app.ts 的 import 会触发 config 顶层求值，不便单独断言）。
 */
export function resolveEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  // Mailpit 联调/e2e：真发到本地 Mailpit SMTP sink（无 STARTTLS），供浏览器 e2e 抓邮件链接。
  // 仅显式 MAILER=mailpit 触发；生产/开发默认路径不受影响。
  if (env.MAILER === 'mailpit') {
    return new SmtpEmailSender(
      {
        ...env,
        SMTP_HOST: env.MAILPIT_HOST ?? '127.0.0.1',
        SMTP_PORT: env.MAILPIT_PORT ?? '1025',
        SMTP_SECURE: 'false',
        SMTP_USER: '',
        SMTP_FROM: env.SMTP_FROM || 'no-reply@localhost.test',
      },
      { allowInsecure: true },
    );
  }
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