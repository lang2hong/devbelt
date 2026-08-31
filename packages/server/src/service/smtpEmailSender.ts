import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSender } from './emailSender.js';

/**
 * SMTP 邮件发送器（生产实现，实施规格 §4.7）。
 *
 * 凭据只来自部署环境变量：SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM。
 * 未配置 SMTP_HOST 时应由装配层回退到 LogEmailSender，绝不本类内置凭据回退。
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const host = (env.SMTP_HOST || '').trim();
    if (!host) throw new Error('SMTP_HOST is required to construct SmtpEmailSender');
    this.from = (env.SMTP_FROM || 'no-reply@localhost').trim();
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(env.SMTP_PORT || 587),
      secure: (env.SMTP_SECURE || 'false') === 'true',
      auth: env.SMTP_USER
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' }
        : undefined,
    });
  }

  async sendVerificationEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    // 正文只含收件人展示名、动作说明、一次性链接与可复制 token —— 不含密码/其他 token/内部内容。
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: 'DB Client email verification',
      text: `Hi${input.displayName ? ` ${input.displayName}` : ''},\n\n` +
        `Verify your email for DB Client by visiting the link below. It expires in 24 hours.\n\n` +
        `Verification link (one-time): ${this.verificationUrl(input.token)}\n\n` +
        `Or paste this verification token into the extension: ${input.token}\n`,
    });
  }

  /** 一次性验证链接。生产域名来自 SMTP_BASE_URL，仅本地开发裁剪。 */
  private verificationUrl(token: string): string {
    const base = (process.env.SMTP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${base}/verify-email?token=${encodeURIComponent(token)}`;
  }

  async sendAlreadyRegisteredEmail(input: { to: string }): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: 'DB Client account',
      text: 'This email is already registered with DB Client. ' +
        'If you forgot your password, use the password reset flow (not yet available).\n',
    });
  }

  async sendInvitationEmail(input: { to: string; organizationName: string; token: string; displayName?: string; expiresTime: Date }): Promise<void> {
    const days = Math.max(1, Math.round((input.expiresTime.getTime() - Date.now()) / 86_400_000));
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: `Invitation to ${input.organizationName} on DB Client`,
      text: `You've been invited to join the organization "${input.organizationName}" on DB Client.\n\n` +
        `Accept the invitation by visiting the link below. It expires in ${days} day(s).\n\n` +
        `Invitation link (one-time): ${this.invitationUrl(input.token)}\n`,
    });
  }

  /** 一次性邀请链接。 */
  private invitationUrl(token: string): string {
    const base = (process.env.SMTP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${base}/accept-invitation?token=${encodeURIComponent(token)}`;
  }
}