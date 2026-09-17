import { createHash, randomBytes } from 'crypto';
import {
  EmailVerificationAlreadyConfirmedError,
  EmailVerificationInvalidError,
  InvitationInvalidError,
  LinkFlowInvalidError,
  ValidationError,
} from '../../../domain/errors.js';
import type {
  IMailFlowRepo,
  IEmailVerificationTokenRepo,
  ISyncResetTokenRepo,
  IUserRepo,
  IOrganizationInvitationRepo,
  IOrganizationRepo,
  IOrganizationSubscriptionRepo,
  IMembershipRepo,
} from '../../../repository/interfaces.js';
import type { MailFlow } from '../../../domain/entities.js';
import type { OrganizationRole } from '../../../domain/enums.js';
import type { TxRunner, Queryable } from '../../../repository/mysql/db.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import { decodeB64Url } from '../../db/service/syncCrypto.js';

/** 邮件流短时有效（§5.1：签发后 10 分钟）。 */
const MAIL_FLOW_TTL_MS = 10 * 60 * 1000;

/** 邮箱验证/邀请 token 的固定形态：32 字节随机值 base64url 编码 = 43 字符。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export interface LinkFlowClaimResult {
  nonce: string;
  /** false 表示复用既有 issued 邮件流（同浏览器重复认领同一 token）。 */
  created: boolean;
}

export interface AcceptInvitationOrganization {
  organizationId: number;
  name: string;
  status: string;
  closedTime: Date | null;
  role: OrganizationRole;
}

export type AcceptInvitationResult =
  | { kind: 'accepted'; organization: AcceptInvitationOrganization }
  | { kind: 'already-accepted'; organization: AcceptInvitationOrganization };

/**
 * 一次性邮件链接服务（P3 §5）：verify-email（切片 1）、accept-invitation（切片 3）与
 * sync-reset 认领（切片 5）。
 *
 * - claim：校验 type/token 形态，幂等认领（同 nonce 复用），签发 opaque nonce，按 IP + token 限流；
 *   verify-email/accept-invitation/sync-reset 三种类型各自解析对应 token 表的 target_record_id。
 * - verifyEmail：以 nonce 定位 mail_flow，事务内消费验证 token + 标记邮箱已验。
 * - bindFlowToUser：登录成功后把 mail_flow 绑定到 authUserId（§5.3/§5.4）。
 * - acceptInvitation：console-only 消费，固定锁序（§5.3）。
 *
 * 只认领并定位 sync-reset token（不签发 handoff、不调用同步 API、不处理 newState；
 * handoff 签发与最终 reset 在 SyncResetService，见 §5.4/P2 交接协议）。
 */
export class LinkFlowService {
  constructor(
    private readonly mailFlowRepo: IMailFlowRepo,
    private readonly emailVerificationTokenRepo: IEmailVerificationTokenRepo,
    private readonly syncResetTokenRepo: ISyncResetTokenRepo,
    private readonly userRepo: IUserRepo,
    private readonly invitationRepo: IOrganizationInvitationRepo,
    private readonly organizationRepo: IOrganizationRepo,
    private readonly organizationSubscriptionRepo: IOrganizationSubscriptionRepo,
    private readonly membershipRepo: IMembershipRepo,
    private readonly runner: TxRunner,
    private readonly rateLimiter: RateLimitService,
  ) {}

  async claim(args: { type: string; token: string; ip?: string; existingNonce?: string }): Promise<LinkFlowClaimResult> {
    if (args.type !== 'verify-email' && args.type !== 'accept-invitation' && args.type !== 'sync-reset') {
      throw new ValidationError('unsupported link flow type');
    }
    if (!TOKEN_PATTERN.test(args.token)) {
      throw new ValidationError('malformed link token');
    }

    // 认领限流：IP 每秒/每分钟 + token hash 每分钟/每小时（防 token 枚举，§6）。
    const ip = args.ip ?? 'unknown';
    await this.rateLimiter.hit(`linkflow:ip:1s:${ip}`, 1, 10);
    await this.rateLimiter.hit(`linkflow:ip:1m:${ip}`, 60, 60);
    const tokenHashHex = sha256hex(args.token);
    await this.rateLimiter.hit(`linkflow:token:1m:${tokenHashHex}`, 60, 5);
    await this.rateLimiter.hit(`linkflow:token:1h:${tokenHashHex}`, 3600, 20);

    const targetTokenHash = sha256(args.token);
    const now = new Date();

    // 同浏览器重复认领：既有 issued 且未过期的同 token 邮件流直接复用，不新建、不重复发。
    if (args.existingNonce) {
      const existing = await this.mailFlowRepo.findByNonceHash(sha256(args.existingNonce));
      if (
        existing &&
        existing.type === args.type &&
        existing.status === 'issued' &&
        existing.expiresTime > now &&
        existing.targetTokenHash.equals(targetTokenHash)
      ) {
        return { nonce: args.existingNonce, created: false };
      }
    }

    // 解析目标 token 表行 id：类型决定对应 token 表（验证 → email_verification_tokens，
    // 邀请 → organization_invitations，同步重置 → personal_sync_reset_tokens）。未知/过期
    // token 无法解析时 targetRecordId 为 null，消费阶段统一失效。
    let targetRecordId: number | null = null;
    if (args.type === 'verify-email') {
      const tokenRecord = await this.emailVerificationTokenRepo.findByHash(tokenHashHex);
      targetRecordId = tokenRecord ? tokenRecord.id : null;
    } else if (args.type === 'accept-invitation') {
      const invitation = await this.invitationRepo.findByTokenHash(tokenHashHex);
      targetRecordId = invitation ? invitation.id : null;
    } else {
      // sync-reset：邮件链接 token 是 32 字节 raw 的 base64url；token_hash 存 SHA-256(raw)。
      const raw = decodeB64Url(args.token, 32, 'token');
      const resetToken = await this.syncResetTokenRepo.findByHash(sha256(raw));
      targetRecordId = resetToken ? resetToken.id : null;
    }

    const nonce = randomBytes(32).toString('base64url');
    const expiresTime = new Date(now.getTime() + MAIL_FLOW_TTL_MS);
    await this.mailFlowRepo.create({
      type: args.type as MailFlow['type'],
      targetTokenHash,
      targetRecordId,
      userId: null,
      nonceHash: sha256(nonce),
      expiresTime,
    });

    return { nonce, created: true };
  }

  async verifyEmail(nonce: string): Promise<{ ok: true; userId: number; tokenId: number }> {
    const nonceHash = sha256(nonce);

    // 每 mail-flow 限流（§6）。
    await this.rateLimiter.hit(`linkflow:flow:1m:${nonceHash.toString('hex')}`, 60, 10);

    return this.runner(async (tx) => {
      const flow = await this.mailFlowRepo.findByNonceHashForUpdate(tx, nonceHash);
      if (!flow || flow.type !== 'verify-email') throw new EmailVerificationInvalidError();
      if (flow.status === 'consumed') throw new EmailVerificationAlreadyConfirmedError();
      if (flow.status !== 'issued' || flow.expiresTime <= new Date()) {
        throw new EmailVerificationInvalidError();
      }

      return this.consumeVerification(tx, flow, new Date());
    });
  }

  /**
   * 登录成功后把 mail_flow 绑定到当前用户（§5.3「服务端登录后 mail-flow 绑定」）。
   * 幂等：仅 issued 且未过期、且尚未绑定（或已绑定同一用户）时写入；其余情况抛
   * LinkFlowInvalidError（绑定是后续消费的前置门槛，失败即终止，不得静默放行）。
   */
  async bindFlowToUser(nonce: string, userId: number): Promise<void> {
    const nonceHash = sha256(nonce);
    await this.runner(async (tx) => {
      const flow = await this.mailFlowRepo.findByNonceHashForUpdate(tx, nonceHash);
      if (!flow || flow.status !== 'issued') throw new LinkFlowInvalidError();
      if (flow.expiresTime <= new Date()) throw new LinkFlowInvalidError();
      if (flow.userId != null && flow.userId !== userId) throw new LinkFlowInvalidError();
      await this.mailFlowRepo.bindUser(tx, flow.id, userId);
    });
  }

  /**
   * 接受组织邀请（console-only，§5.3）。以 mail_flow 记录（非路径 token）作为凭据，
   * 固定锁序：mail_flow → organization → subscription → invitation → membership。
   * flow 必须已由 bindFlowToUser 绑定到当前登录用户（未绑定/绑定他人一律 400）。
   *
   * 其余路径（跨账号 / 失效 / 已被其他 flow 消费 / 组织关闭 / 用户未验证）统一
   * 400 INVITATION_INVALID，不泄露更多状态。
   */
  async acceptInvitation(nonce: string, userId: number): Promise<AcceptInvitationResult> {
    const nonceHash = sha256(nonce);

    // 预读（非锁）拿 target_record_id 与组织归属，供后续锁序定位。
    const flowHint = await this.mailFlowRepo.findByNonceHash(nonceHash);
    if (!flowHint || flowHint.type !== 'accept-invitation' || flowHint.targetRecordId == null) {
      throw new InvitationInvalidError();
    }
    const invHint = await this.invitationRepo.findById(flowHint.targetRecordId);
    if (!invHint) throw new InvitationInvalidError();

    return this.runner(async (tx) => {
      const now = new Date();

      // 1. mail_flow FOR UPDATE（唯一 nonce，其余两端点也以此行为首锁，避免反向锁序）。
      const flow = await this.mailFlowRepo.findByNonceHashForUpdate(tx, nonceHash);
      if (!flow || flow.type !== 'accept-invitation' || flow.targetRecordId == null) {
        throw new InvitationInvalidError();
      }
      if (flow.status !== 'issued' || flow.expiresTime <= now) throw new InvitationInvalidError();
      // 绑定是消费的前置条件（§5.3 裁定）：flow 必须已绑定到当前登录用户（未绑定/绑定他人 → 400）。
      if (flow.userId !== userId) throw new InvitationInvalidError();

      // 2. organization FOR UPDATE。
      const org = await this.organizationRepo.lockById(tx, invHint.organizationId);
      if (!org || org.status !== 'active') throw new InvitationInvalidError();

      // 3. subscription FOR UPDATE。
      const sub = await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, org.id);
      if (!sub || sub.status !== 'active') throw new InvitationInvalidError();

      // 4. membership FOR UPDATE（用预读 membershipId；与组织路径统一锁序：membership → invitation）。
      const membership = await this.membershipRepo.findByIdForUpdate(tx, invHint.membershipId);
      if (!membership || membership.organizationId !== org.id) throw new InvitationInvalidError();

      // 5. invitation FOR UPDATE（通过 target_record_id）。
      const inv = await this.invitationRepo.findByIdForUpdate(tx, flow.targetRecordId);
      if (!inv || inv.organizationId !== org.id) throw new InvitationInvalidError();

      // 用户 active 且邮箱已验证。
      const user = await this.userRepo.findByIdInTx(tx, userId);
      if (!user || user.status !== 'active' || !user.emailVerifiedTime) throw new InvitationInvalidError();

      // 授权判据：membership.userId === 当前登录用户（跨账号 → 400，不泄露）。
      if (membership.userId !== userId) throw new InvitationInvalidError();

      const organization: AcceptInvitationOrganization = {
        organizationId: org.id,
        name: org.name,
        status: org.status,
        closedTime: org.closedTime,
        role: membership.role,
      };

      if (inv.revokedTime || inv.expiresTime <= now) throw new InvitationInvalidError();

      if (inv.acceptedTime) {
        // 已被消费：仅当仍是本 flow 对应 invitation 且 membership active、用户仍为成员
        // 时幂等返回 409（摘要从 membership 重新读取，不依赖旧结果缓存），同时消费本 flow。
        if (membership.status !== 'active') throw new InvitationInvalidError();
        await this.mailFlowRepo.markConsumed(tx, flow.id, now);
        return { kind: 'already-accepted', organization };
      }

      // 未消费：执行接受（标记 invitation accepted + membership active）。
      if (membership.status !== 'invited') throw new InvitationInvalidError();
      await this.invitationRepo.markAccepted(tx, inv.id, now);
      await this.membershipRepo.activate(tx, membership.id, now);
      await this.mailFlowRepo.markConsumed(tx, flow.id, now);

      return { kind: 'accepted', organization };
    });
  }

  /**
   * 消费验证 token（锁序须与旧 confirmEmail 的 user→token 相对序同构，避免两端点并发
   * 消费同一 token/user 时构成死锁环）：flow(FOR UPDATE) → 无锁读 token 取 userId →
   * user(FOR UPDATE) → token(FOR UPDATE) 复核。
   */
  private async consumeVerification(
    tx: Queryable,
    flow: MailFlow,
    now: Date,
  ): Promise<{ ok: true; userId: number; tokenId: number }> {
    if (flow.targetRecordId == null) throw new EmailVerificationInvalidError();

    const tokenRead = await this.emailVerificationTokenRepo.findByIdInTx(tx, flow.targetRecordId);
    if (!tokenRead) throw new EmailVerificationInvalidError();

    const user = await this.userRepo.lockById(tx, tokenRead.userId);
    if (!user) throw new EmailVerificationInvalidError();

    const token = await this.emailVerificationTokenRepo.findByIdForUpdate(tx, flow.targetRecordId);
    if (!token) throw new EmailVerificationInvalidError();
    if (token.consumedTime) throw new EmailVerificationAlreadyConfirmedError();
    if (token.expiresTime <= now) throw new EmailVerificationInvalidError();

    await this.emailVerificationTokenRepo.consume(tx, token.id, now);
    await this.userRepo.markEmailVerified(tx, token.userId, now);
    await this.mailFlowRepo.markConsumed(tx, flow.id, now);

    return { ok: true, userId: token.userId, tokenId: token.id };
  }
}