/**
 * 邮件投递抽象（实施规格 §5.1：业务事务提交后再发送邮件）。
 *
 * 服务端只通过单一 EmailSender 发送邮箱验证与组织邀请邮件。
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
  /** 发送「该邮箱已注册」提示（防枚举，见实施规格 §5.1）。 */
  sendAlreadyRegisteredEmail(input: { to: string }): Promise<void>;
  /** 发送组织邀请邮件。token 为**明文**（仅用于构造一次链接），不得落日志。 */
  sendInvitationEmail(input: {
    to: string;
    organizationName: string;
    token: string;
    displayName?: string;
    expiresTime: Date;
  }): Promise<void>;
  /** 发送同步 reset-after-loss 邮箱挑战邮件。token 为**明文**（仅用于构造一次链接），不得落日志。 */
  sendResetChallengeEmail(input: {
    to: string;
    token: string;
    displayName?: string;
  }): Promise<void>;
  /**
   * 发送账号恢复材料已下发安全通知（无 token、无口令、无任何同步材料）。
   * 仅提醒账户所有者「恢复材料刚被访问」，供其判断是否恶意，不含可操作链接。
   */
  sendAccountRecoveryActivityEmail(input: {
    to: string;
    displayName?: string;
  }): Promise<void>;
}

/** 收件箱捕获（测试替身用）：记录发送出去的邮件，供断言。 */
export interface SentEmail {
  kind: 'verification' | 'already_registered' | 'invitation' | 'reset_challenge' | 'account_recovery_activity';
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

  async sendResetChallengeEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    this.sent.push({ kind: 'reset_challenge', to: input.to, token: input.token, displayName: input.displayName });
  }

  async sendAccountRecoveryActivityEmail(input: { to: string; displayName?: string }): Promise<void> {
    this.sent.push({ kind: 'account_recovery_activity', to: input.to, displayName: input.displayName });
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

  async sendResetChallengeEmail(input: { to: string; token: string; displayName?: string }): Promise<void> {
    console.info(`[email:stub] reset challenge email would be sent to ${input.to}`);
  }

  async sendAccountRecoveryActivityEmail(input: { to: string; displayName?: string }): Promise<void> {
    console.info(`[email:stub] account recovery activity email would be sent to ${input.to}`);
  }
}
