/**
 * 邮件投递抽象（实施规格 §4.7）。
 *
 * 服务端只通过单一 EmailSender 发送邮件。Phase 1 有两类邮件：邮箱验证与组织邀请。
 * 生产环境使用部署环境注入的 SMTP 凭据，凭据只来自环境配置、不入库、不经 API 返回。
 * 测试与本地开发必须使用可断言的替身，禁止向真实地址发信。
 *
 * 发送失败不回滚已提交的注册/邀请/token，只记录不含 token 明文的失败日志。
 */
export interface EmailSender {
  /** 发送一次性邮箱验证链接邮件。token 为**明文**（仅用于构造一次链接），不得落日志。 */
  sendVerificationEmail(input: {
    to: string;
    token: string;
    displayName?: string;
  }): Promise<void>;
  /** 发送「该邮箱已注册」提示（防枚举，见实施规格 §5 末段）。 */
  sendAlreadyRegisteredEmail(input: { to: string }): Promise<void>;
  /** 发送组织邀请邮件。token 为**明文**（仅用于构造一次链接），不得落日志。 */
  sendInvitationEmail(input: {
    to: string;
    organizationName: string;
    token: string;
    displayName?: string;
    expiresTime: Date;
  }): Promise<void>;
}

/** 收件箱捕获（测试替身用）：记录发送出去的邮件，供断言。 */
export interface SentEmail {
  kind: 'verification' | 'already_registered' | 'invitation';
  to: string;
  token?: string;
  displayName?: string;
  organizationName?: string;
  expiresTime?: Date;
}

/**
 * 可断言的测试替身。收集发送记录，不发真实邮件。
 */
export class MemoryEmailSender implements EmailSender {
  readonly sent: SentEmail[] = [];

  async sendVerificationEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    this.sent.push({ kind: 'verification', to: input.to, token: input.token, displayName: input.displayName });
  }

  async sendAlreadyRegisteredEmail(input: { to: string }): Promise<void> {
    this.sent.push({ kind: 'already_registered', to: input.to });
  }

  async sendInvitationEmail(input: { to: string; organizationName: string; token: string; displayName?: string; expiresTime: Date }): Promise<void> {
    this.sent.push({ kind: 'invitation', to: input.to, token: input.token, organizationName: input.organizationName, displayName: input.displayName, expiresTime: input.expiresTime });
  }
}

/**
 * 开发回落发送器：只记录日志，绝不向真实地址发信。
 * 生产环境应改用 SMTP 实现（见 app 装配层按 SMTP_* 环境变量选择）。
 */
export class LogEmailSender implements EmailSender {
  async sendVerificationEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    // 刻意不记录 token 明文：即使是开发环境也遵守「token 不落日志」的契约。
    console.info(`[email:stub] verification email would be sent to ${input.to}`);
  }

  async sendAlreadyRegisteredEmail(input: { to: string }): Promise<void> {
    console.info(`[email:stub] already-registered email would be sent to ${input.to}`);
  }

  async sendInvitationEmail(input: { to: string; organizationName: string; token: string; displayName?: string; expiresTime: Date }): Promise<void> {
    console.info(`[email:stub] invitation email would be sent to ${input.to} for ${input.organizationName}`);
  }
}