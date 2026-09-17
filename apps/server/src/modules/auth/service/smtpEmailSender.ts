import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSender } from './emailSender.js';

/**
 * SMTP 邮件发送器（生产实现，实施规格 §5.1）。
 *
 * 凭据只来自部署环境变量：SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM。
 * 未配置 SMTP_HOST 时应由装配层回退到 LogEmailSender，绝不本类内置凭据回退。
 *
 * 邮件正文：统一品牌外壳 + 主行动按钮 + 一次性链接（纯文本回退），
 * 验证类邮件额外给「可复制验证码」卡片（扩展登录表单需要粘贴 token）。
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly baseUrl: string;

  constructor(env: NodeJS.ProcessEnv = process.env, opts: { allowInsecure?: boolean } = {}) {
    const host = (env.SMTP_HOST || '').trim();
    if (!host) throw new Error('SMTP_HOST is required to construct SmtpEmailSender');
    this.from = (env.SMTP_FROM || 'no-reply@localhost').trim();
    // 从注入的 env 读取（不要直读 process.env）：否则构造器的可注入 env 契约被绕过，
    // 测试无法覆盖链接生成，且部署时容易出现「改了 env 但链接还是旧域名」。
    this.baseUrl = (env.SMTP_BASE_URL || 'http://localhost:5173').trim().replace(/\/$/, '');

    const secure = (env.SMTP_SECURE || 'false') === 'true';
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(env.SMTP_PORT || 587),
      secure,
      // secure=false（587/STARTTLS）时**必须**强制 TLS。
      // nodemailer 默认是「机会性」升级：服务端不广告 STARTTLS 就静默用明文发送。
      // 中间人只要抹掉 STARTTLS 广告，验证 / 邀请 / sync-reset 的一次性 token
      // 就会明文过网 —— 那些 token 等同于账号控制权。
      // requireTLS 让升级失败即报错，宁可发不出去也不明文发。
      // 唯一例外：本地 Mailpit 联调/e2e（allowInsecure），Mailpit 的 SMTP sink 不提供
      // STARTTLS；仅允许显式开启，生产装配绝不可传该选项。
      requireTLS: opts.allowInsecure ? false : !secure,
      auth: env.SMTP_USER
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' }
        : undefined,
    });
  }

  async sendVerificationEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    const greeting = `Hi${input.displayName ? ` ${input.displayName}` : ''}`;
    const url = this.verificationUrl(input.token);
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: '验证你的 DB Client 邮箱',
      text:
        '验证你的邮箱\n\n' +
        `${greeting}，你好：\n\n` +
        '你已注册 DB Client。点击下方链接完成邮箱验证（链接 24 小时内有效）：\n\n' +
        `${url}\n\n` +
        `或在扩展中粘贴验证码：${input.token}\n\n` +
        '如果你没有注册过 DB Client，请忽略本邮件。',
      html: this.wrap(
        this.heading('验证你的邮箱', greeting) +
        '<p style="margin:12px 0 0;color:#57606a;font-size:14px;line-height:1.7;">你已注册 DB Client 账号。点击下方按钮完成邮箱验证，链接 <b>24 小时内</b>有效。</p>' +
        this.button('验证邮箱', url) +
        this.tokenCard('验证码', input.token),
      ),
    });
  }

  async sendAlreadyRegisteredEmail(input: { to: string }): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: 'DB Client 账号提示',
      text:
        '这个邮箱已在 DB Client 注册过。\n\n' +
        '如果忘记了密码，可在登录页面使用找回功能（如尚未开放请联系管理员）。\n' +
        '如果不是你本人注册的，请忽略本邮件。',
      html: this.wrap(
        this.heading('这个邮箱已注册', undefined) +
        '<p style="margin:12px 0 0;color:#57606a;font-size:14px;line-height:1.7;">这个邮箱已注册过 DB Client。若忘记密码，请在登录页使用找回功能。</p>' +
        '<p style="margin:8px 0 0;color:#8b949e;font-size:13px;">如果不是你本人注册的，请忽略本邮件。</p>',
      ),
    });
  }

  async sendInvitationEmail(input: { to: string; organizationName: string; token: string; displayName?: string; expiresTime: Date }): Promise<void> {
    const days = Math.max(1, Math.round((input.expiresTime.getTime() - Date.now()) / 86_400_000));
    const url = this.invitationUrl(input.token);
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: `邀请你加入团队「${input.organizationName}」`,
      text:
        `你被邀请加入组织「${input.organizationName}」。\n\n` +
        `点击下方链接接受邀请（${days} 天内有效）：\n\n${url}\n\n` +
        '如果你不认识这个组织，请忽略本邮件。',
      html: this.wrap(
        this.heading('邀请你加入团队', undefined) +
        `<p style="margin:12px 0 0;color:#57606a;font-size:14px;line-height:1.7;">你被邀请加入组织「<b>${this.escapeHtml(input.organizationName)}</b>」。点击下方按钮接受邀请，链接 <b>${days} 天</b>内有效。</p>` +
        this.button('接受邀请', url),
      ),
    });
  }

async sendResetChallengeEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    const greeting = `Hi${input.displayName ? ` ${input.displayName}` : ''}`;
    const url = this.resetUrl(input.token);
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: 'DB Client 同步重置确认',
      text:
        '同步重置确认\n\n' +
        `${greeting}，你好：\n\n` +
        '你的 DB Client 账号请求了一次同步重置。点击下方链接确认（24 小时内有效）：\n\n' +
        `${url}\n\n` +
        '如果这不是你的操作，请忽略本邮件，并检查你的账号安全。',
      html: this.wrap(
        this.heading('同步重置确认', greeting) +
        '<p style="margin:12px 0 0;color:#57606a;font-size:14px;line-height:1.7;">你的账号请求了一次同步重置。点击下方按钮确认，链接 <b>24 小时内</b>有效。</p>' +
        this.button('确认重置', url),
      ),
    });
  }

  async sendAccountRecoveryActivityEmail(input: { to: string; displayName?: string }): Promise<void> {
    const greeting = `Hi${input.displayName ? ` ${input.displayName}` : ''}`;
    // 安全通知：刻意不包含任何 token / 恢复材料 / 口令 / 链接，仅告知事件发生。
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: 'DB Client 账号同步恢复已使用',
      text:
        '账号同步恢复提醒\n\n' +
        `${greeting}，你好：\n\n` +
        '你的 DB Client 账号刚刚执行了一次「账号同步恢复」，服务端已向该请求签发云端同步数据的恢复材料。\n\n' +
        '如果这是你本人操作，可忽略本邮件。\n\n' +
        '如果不是你本人操作，说明你的账号登录可能已泄露，请立即修改账户密码，并检查账号安全。',
      html: this.wrap(
        this.heading('账号同步恢复提醒', greeting) +
        '<p style="margin:12px 0 0;color:#57606a;font-size:14px;line-height:1.7;">你的账号刚刚执行了一次「账号同步恢复」，服务端已签发云端同步数据的恢复材料。</p>' +
        '<p style="margin:8px 0 0;color:#57606a;font-size:14px;line-height:1.7;">如果这不是你的操作，请立即修改账户密码，并检查账号安全。</p>',
      ),
    });
  }

  // ── URL 构造 ──

  private verificationUrl(token: string): string {
    return `${this.baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  }

  private invitationUrl(token: string): string {
    return `${this.baseUrl}/accept-invitation?token=${encodeURIComponent(token)}`;
  }

  private resetUrl(token: string): string {
    return `${this.baseUrl}/db/sync-reset?token=${encodeURIComponent(token)}`;
  }

  // ── HTML 生成 ──

  /** 品牌外壳：统一配色 / 圆角卡片 / 底部安全提示。inner 为正文核心区 HTML。 */
  private wrap(inner: string): string {
    return `<div style="font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328;">` +
      `<div style="background:#f6f8fa;padding:24px 12px;">` +
      `<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:28px 32px;">` +
      `<div style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 4px;">DB Client</div>` +
      `<div style="height:1px;background:#eaeef2;margin:16px 0;"></div>` +
      inner +
      `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eaeef2;color:#8b949e;font-size:12px;line-height:1.7;">这是一封系统自动发送的邮件，请勿回复。如果你没有发起此操作，请忽略本邮件。</div>` +
      `</div></div></div>`;
  }

  /** 标题 + 可选问候语。 */
  private heading(title: string, greeting?: string): string {
    return `<div style="font-size:18px;font-weight:600;color:#1f2328;margin:0;">${this.escapeHtml(title)}</div>` +
      (greeting ? `<div style="font-size:14px;color:#57606a;margin:6px 0 0;">${this.escapeHtml(greeting)}</div>` : '');
  }

  /** 主行动按钮。 */
  private button(label: string, url: string): string {
    return `<div style="margin:22px 0;text-align:center;">` +
      `<a href="${url}" style="display:inline-block;background:#0969da;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:15px;font-weight:600;">${this.escapeHtml(label)}</a>` +
      `</div>`;
  }

  /** 可复制验证码卡片（扩展登录表单粘贴用）。 */
  private tokenCard(label: string, token: string): string {
    return `<div style="color:#57606a;font-size:13px;margin:4px 0 8px;">如果按钮无法点击，请在扩展中粘贴此${this.escapeHtml(label)}：</div>` +
      `<div style="padding:12px;background:#f6f8fa;border:1px solid #eaeef2;border-radius:6px;font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;font-size:15px;letter-spacing:1px;text-align:center;word-break:break-all;color:#0f172a;">${this.escapeHtml(token)}</div>`;
  }

  /** 转义用户可控文本，防止 HTML 注入（组织名、展示名等）。 */
  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}