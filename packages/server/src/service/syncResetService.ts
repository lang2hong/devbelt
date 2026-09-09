import { randomBytes, createHash } from 'crypto';
import type { TxRunner } from '../repository/mysql/db.js';
import type {
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncResetTokenRepo,
  ISyncResetHandoffRepo,
  IMailFlowRepo,
  IUserRepo,
} from '../repository/interfaces.js';
import {
  SyncVersionConflictError,
  SyncStateExistsError,
  SyncResetHandoffInvalidError,
  SyncResetHandoffReusedError,
  SyncResetInProgressError,
  DomainError,
} from '../domain/errors.js';
import { incU64 } from '../domain/syncU64.js';
import { validateNewState, toState, toDto, type SyncNewState, type StateDto } from './syncStateService.js';
import type { EmailSender } from './emailSender.js';
import type { RateLimitService } from './rateLimitService.js';
import type { AuditWriter } from './auditWriter.js';

const RESET_CHALLENGE_WINDOW_S = 3600;
const RESET_CHALLENGE_MAX = 3;
const RESET_TOKEN_TTL_MS = 24 * 3600 * 1000;
/** handoff ticket 15 分钟、单次消费（§5.4）。 */
const HANDOFF_TTL_MS = 15 * 60 * 1000;
/** processing 超时（崩溃恢复）：超过 60s 未完成的 handoff 自动回退为 issued。 */
const HANDOFF_PROCESSING_TIMEOUT_MS = 60 * 1000;

/** reset token / handoff ticket 均只存 SHA-256 摘要。 */
function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}

export interface ResetAfterLossWithHandoffInput {
  /** 256-bit handoff ticket（raw 32 bytes）。 */
  handoffTicket: Buffer;
  newState: SyncNewState;
  /** SHA-256(JCS({ newState }))，completed 回放比对用（route 层计算）。 */
  requestDigest: Buffer;
}

/**
 * reset-after-loss 挑战与两阶段交接协议。
 *
 * - reset-challenges：认证用户发起，向已验证邮箱发邮件挑战；对 active/none/abandoned
 *   恒同响应（防枚举）；按 user+IP 各自每小时 3 次限流。token 仅存 SHA-256，24h 单次消费，
 *   重发作废旧 token。
 * - create-sync-reset-handoff：浏览器凭 mail_flow Cookie nonce 签发 15 分钟单次 handoff
 *   ticket（仅存 SHA-256），锁序 reset_token → mail_flow → handoff。
 * - reset-after-loss（handoff）：扩展凭 handoffTicket 提交 newState，锁序 reset_token →
 *   handoff；completed 同摘要回放返回首次 StateDto；processing 60s 崩溃回退；单事务消费
 *   ticket+token、tombstone 旧 epoch、写完整 StateDto 收据。
 */
export class SyncResetService {
  constructor(
    private readonly stateRepo: ISyncStateRepo,
    private readonly recordRepo: ISyncRecordRepo,
    private readonly resetTokenRepo: ISyncResetTokenRepo,
    private readonly userRepo: IUserRepo,
    private readonly runner: TxRunner,
    private readonly emailSender: EmailSender,
    private readonly rateLimiter: RateLimitService,
    private readonly mailFlowRepo: IMailFlowRepo,
    private readonly handoffRepo: ISyncResetHandoffRepo,
    private readonly auditWriter: AuditWriter,
  ) {}

  async requestResetChallenge(userId: number, ip?: string): Promise<void> {
    await this.rateLimiter.hit(`syncreset:user:${userId}`, RESET_CHALLENGE_WINDOW_S, RESET_CHALLENGE_MAX);
    await this.rateLimiter.hit(`syncreset:ip:${ip ?? 'unknown'}`, RESET_CHALLENGE_WINDOW_S, RESET_CHALLENGE_MAX);

    const user = await this.userRepo.findById(userId);
    // 仅向已验证邮箱发挑战；未验证则不发信、不建 token，仍同形返回（防枚举）。
    if (!user || !user.emailVerifiedTime) return;

    const token = randomBytes(32);
    const tokenHash = sha256(token);
    const expiresTime = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await this.runner(async (tx) => {
      // 重发作废既有未消费 token + 新建，同事务保证「至多一个有效 token」。
      await this.resetTokenRepo.revokePendingByUser(tx, userId, new Date());
      await this.resetTokenRepo.create(tx, { userId, tokenHash, expiresTime });
    });

    // 事务 commit 后发送，失败不回滚（用户可重发）；token 明文不落日志。
    await this.emailSender.sendResetChallengeEmail({
      to: user.email,
      token: token.toString('base64url'),
      displayName: user.displayName,
    }).catch((err) => {
      console.warn('[sync] reset challenge email failed', { err: String(err) });
    });
  }

  /**
   * 浏览器签发 handoff（§5.4 步骤 2-3）。凭 mail_flow Cookie nonce + 已登录用户，
   * 消费 reset token 关联的 mail_flow 并签发 15 分钟一次性 ticket。一次性操作：
   * 消费 mail_flow，故不做 Idempotency-Key 重放（§5.4 重试依赖已签发 ticket）。
   */
  async createHandoff(nonce: string, userId: number): Promise<{ openUri: string; expiresTime: string }> {
    const nonceHash = sha256(nonce);

    // 预读（非锁）拿 target_record_id 与归属；正式消费在事务内二次锁定校验。
    const flowHint = await this.mailFlowRepo.findByNonceHash(nonceHash);
    if (!flowHint || flowHint.type !== 'sync-reset' || flowHint.targetRecordId == null || flowHint.userId !== userId) {
      throw new SyncResetHandoffInvalidError();
    }

    const ticket = randomBytes(32);
    const ticketHash = sha256(ticket);
    const ticketB64 = ticket.toString('base64url');
    const expiresTime = new Date(Date.now() + HANDOFF_TTL_MS);

    let handoffId: number | null = null;
    try {
      handoffId = await this.runner(async (tx) => {
        const now = new Date();

        // 锁序 1：reset token（最高优先锁，与扩展消费接口锁序一致）。
        const token = await this.resetTokenRepo.findByIdForUpdate(tx, flowHint.targetRecordId!);
        if (!token || token.userId !== userId || token.consumedTime || token.revokedTime || token.expiresTime <= now) {
          throw new SyncResetHandoffInvalidError();
        }

        // 锁序 2：mail_flow（二次校验，防止并发消费 / 他用户绑定）。
        const flow = await this.mailFlowRepo.findByNonceHashForUpdate(tx, nonceHash);
        if (!flow || flow.type !== 'sync-reset' || flow.status !== 'issued' || flow.expiresTime <= now || flow.userId !== userId) {
          throw new SyncResetHandoffInvalidError();
        }

        // 撤销同一 reset token 下所有 issued/processing 未终结 handoff。
        await this.handoffRepo.revokePendingByResetToken(tx, token.id, now);

        // 创建新 handoff（15 分钟单次消费）。
        const handoff = await this.handoffRepo.create(tx, {
          userId,
          resetTokenId: token.id,
          ticketHash,
          expiresTime,
        });

        // 消费 mail_flow：同一 flow 不得重复签发多个 handoff（§5.4 步骤 3f）。
        await this.mailFlowRepo.markConsumed(tx, flow.id, now);

        return handoff.id;
      });

      this.auditWriter.write({
        eventType: 'sync.reset.handoff.created',
        result: 'success',
        actorUserId: userId,
        targetType: 'sync_reset_handoff',
        targetId: String(handoffId),
      });

      return {
        openUri: `vscode://dbclient.sync/reset-after-loss?handoffTicket=${ticketB64}`,
        expiresTime: expiresTime.toISOString(),
      };
    } catch (e) {
      this.auditWriter.write({
        eventType: 'sync.reset.handoff.failed',
        result: 'failure',
        failureCode: e instanceof DomainError ? e.code : null,
        actorUserId: userId,
        targetType: 'sync_reset_handoff',
        targetId: handoffId == null ? null : String(handoffId),
      });
      throw e;
    }
  }

  /**
   * 扩展消费 handoff 并完成最终 reset（P2 §控制台重置交接协议）。
   * completed 回放返回首次完整 StateDto；processing 60s 内返回 409 IN_PROGRESS，
   * 超时自动回退；一步失败整体回滚（handoff 保持 issued 或可超时回退）。
   */
  async resetAfterLossWithHandoff(userId: number, input: ResetAfterLossWithHandoffInput): Promise<StateDto> {
    validateNewState(input.newState);
    const ticketHash = sha256(input.handoffTicket);

    // 预读（非锁）处理 completed 回放与 processing 快速失败，避免不必要的锁。
    const hint = await this.handoffRepo.findByTicketHash(ticketHash);
    if (!hint || hint.userId !== userId) throw new SyncResetHandoffInvalidError();
    if (hint.status === 'completed') {
      if (hint.requestDigest?.equals(input.requestDigest) && hint.resultStateDtoJson) {
        return JSON.parse(hint.resultStateDtoJson) as StateDto;
      }
      throw new SyncResetHandoffReusedError();
    }
    if (hint.status === 'revoked' || hint.status === 'expired' || hint.expiresTime <= new Date()) {
      throw new SyncResetHandoffInvalidError();
    }
    if (hint.status === 'processing' && Date.now() - hint.updateTime.getTime() <= HANDOFF_PROCESSING_TIMEOUT_MS) {
      throw new SyncResetInProgressError();
    }

    let handoffId: number | null = null;
    try {
      const dto = await this.runner(async (tx) => {
        const now = new Date();

        // 锁序 1：重置 token（仅校验存在与归属；consumed/revoked/expired 延后到
        // 确认 handoff 未完成、需要真正消费时再校验——completed receipt 的同摘要
        // 重放必须优先于 token 的已消费状态，否则并发重试会误报 INVALID）。
        const token = await this.resetTokenRepo.findByIdForUpdate(tx, hint.resetTokenId);
        if (!token || token.userId !== userId) throw new SyncResetHandoffInvalidError();

        // 锁序 2：handoff（FOR UPDATE）二次校验并消费。
        const handoff = await this.handoffRepo.findByTicketHashForUpdate(tx, ticketHash);
        if (!handoff || handoff.userId !== userId) throw new SyncResetHandoffInvalidError();
        if (handoff.status === 'completed') {
          if (handoff.requestDigest?.equals(input.requestDigest) && handoff.resultStateDtoJson) {
            return JSON.parse(handoff.resultStateDtoJson) as StateDto;
          }
          throw new SyncResetHandoffReusedError();
        }
        if (handoff.status === 'revoked' || handoff.status === 'expired' || handoff.expiresTime <= now) {
          throw new SyncResetHandoffInvalidError();
        }
        if (handoff.status === 'processing') {
          if (now.getTime() - handoff.updateTime.getTime() > HANDOFF_PROCESSING_TIMEOUT_MS) {
            await this.handoffRepo.rollbackProcessing(tx, handoff.id, now);
          } else {
            throw new SyncResetInProgressError();
          }
        }

        // 未完成 handoff：此刻才校验 reset token 是否仍可消费。
        if (token.consumedTime || token.revokedTime || token.expiresTime <= now) {
          throw new SyncResetHandoffInvalidError();
        }

        await this.handoffRepo.markProcessing(tx, handoff.id, input.requestDigest, now);
        handoffId = handoff.id;

        // 复用 reset 主体：锁 state → 旧 epoch records 逐个 tombstone → 写新 epoch。
        let next: ReturnType<typeof toState>;
        const state = await this.stateRepo.lockByUserId(tx, userId);
        if (state) {
          let seq = state.changeSequence;
          const active = await this.recordRepo.listActiveByEpoch(tx, userId, state.keyEpoch);
          for (const r of active) {
            seq = incU64(seq);
            const ok = await this.recordRepo.softDelete(tx, userId, state.keyEpoch, r.recordId, r.version, incU64(r.version), seq, now);
            if (!ok) throw new SyncVersionConflictError(r.version);
          }
          next = toState(userId, incU64(state.keyEpoch), '1', seq, input.newState, now);
          const updated = await this.stateRepo.update(tx, userId, state.stateVersion, next);
          if (!updated) throw new SyncVersionConflictError(state.stateVersion);
        } else {
          next = toState(userId, '1', '1', '0', input.newState, now);
          const created = await this.stateRepo.create(tx, next);
          if (!created) throw new SyncStateExistsError();
        }

        await this.resetTokenRepo.consume(tx, token.id, now);
        const dto = toDto(next);
        await this.handoffRepo.markCompleted(tx, handoff.id, now, {
          stateDtoJson: JSON.stringify(dto),
          keyEpoch: next.keyEpoch,
          stateVersion: next.stateVersion,
          changeSequence: next.changeSequence,
        });
        return dto;
      });

      this.auditWriter.write({
        eventType: 'sync.reset.handoff.consumed',
        result: 'success',
        actorUserId: userId,
        targetType: 'sync_reset_handoff',
        targetId: handoffId == null ? null : String(handoffId),
      });
      return dto;
    } catch (e) {
      this.auditWriter.write({
        eventType: 'sync.reset.handoff.failed',
        result: 'failure',
        failureCode: e instanceof DomainError ? e.code : null,
        actorUserId: userId,
        targetType: 'sync_reset_handoff',
        targetId: handoffId == null ? null : String(handoffId),
      });
      throw e;
    }
  }
}