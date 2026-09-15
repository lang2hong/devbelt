import type { IUserRepo } from '../repository/interfaces.js';
import type { AuditWriter } from './auditWriter.js';

/**
 * 平台管理员受控引导。
 *
 * 从 `PLATFORM_ADMIN_EMAILS` 提升管理员存在一个真实攻击面：注册不要求先验证邮箱，
 * 攻击者若能抢在运维之前用该邮箱注册，就会被静默提权。因此提权必须以
 * **邮箱已验证 + 账号 active** 为前提；不满足则告警跳过（fail-closed）。
 *
 * 逻辑独立于 app.ts，便于 CLI（`pnpm -C packages/server admin:promote`）复用与单测。
 */

export type PromoteResult =
  | { kind: 'granted'; userId: number }
  | { kind: 'already-admin'; userId: number }
  | { kind: 'not-registered' }
  | { kind: 'not-verified'; userId: number }
  | { kind: 'not-active'; userId: number };

/** 与注册/登录一致的邮箱规范化：trim + lowercase。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 尝试把单个邮箱提升为 platform_admin。
 * 幂等：已是 platform_admin 时不再写审计，返回 already-admin。
 */
export async function promotePlatformAdmin(
  userRepo: IUserRepo,
  auditWriter: AuditWriter,
  rawEmail: string,
  warn: (msg: string, data?: unknown) => void,
): Promise<PromoteResult> {
  const email = normalizeEmail(rawEmail);
  const user = await userRepo.findByEmail(email);

  if (!user) {
    // env 打错字/用户尚未注册 = 静默无管理员的事故，必须告警。
    warn('PLATFORM_ADMIN_EMAILS entry matches no registered user', { email });
    return { kind: 'not-registered' };
  }
  if (!user.emailVerifiedTime) {
    warn('PLATFORM_ADMIN_EMAILS entry is not email-verified; promotion skipped', { email, userId: user.id });
    return { kind: 'not-verified', userId: user.id };
  }
  if (user.status !== 'active') {
    warn('PLATFORM_ADMIN_EMAILS entry is not active; promotion skipped', { email, userId: user.id });
    return { kind: 'not-active', userId: user.id };
  }
  if (user.role === 'platform_admin') {
    return { kind: 'already-admin', userId: user.id };
  }

  await userRepo.setRole(user.id, 'platform_admin');
  // actorUserId 为 null 表示**系统引导**发起（无人类操作者），与真人提权区分；
  // CLI `admin:promote` 复用同一路径，语义一致。
  auditWriter.write({
    eventType: 'admin.role.granted',
    result: 'success',
    actorUserId: null,
    targetType: 'user',
    targetId: String(user.id),
  });
  return { kind: 'granted', userId: user.id };
}

/** 启动期受控引导：逐个处理 `PLATFORM_ADMIN_EMAILS`（幂等）。 */
export async function bootstrapPlatformAdmins(
  userRepo: IUserRepo,
  auditWriter: AuditWriter,
  emails: readonly string[],
  warn: (msg: string, data?: unknown) => void,
): Promise<void> {
  if (emails.length === 0) {
    warn('PLATFORM_ADMIN_EMAILS not configured; platform admin surface is fail-closed');
    return;
  }
  for (const email of emails) {
    await promotePlatformAdmin(userRepo, auditWriter, email, warn);
  }
}