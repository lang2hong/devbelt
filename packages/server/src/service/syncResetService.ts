import { randomBytes, createHash } from 'crypto';
import type { TxRunner } from '../repository/mysql/db.js';
import type {
  ISyncStateRepo,
  ISyncRecordRepo,
  ISyncResetTokenRepo,
  IUserRepo,
} from '../repository/interfaces.js';
import {
  ValidationError,
  SyncVersionConflictError,
  SyncStateExistsError,
} from '../domain/errors.js';
import { incU64 } from '../domain/syncU64.js';
import { validateNewState, toState, type SyncNewState } from './syncStateService.js';
import type { EmailSender } from './emailSender.js';
import type { RateLimitService } from './rateLimitService.js';

const RESET_CHALLENGE_WINDOW_S = 3600;
const RESET_CHALLENGE_MAX = 3;
const RESET_TOKEN_TTL_MS = 24 * 3600 * 1000;

/** reset token 只存 SHA-256 摘要。 */
function hashResetToken(raw: Buffer): Buffer {
  return createHash('sha256').update(raw).digest();
}

export interface ResetAfterLossInput {
  /** 256-bit reset token（raw 32 bytes，Babs64Url43 解码后）。 */
  resetToken: Buffer;
  newState: SyncNewState;
}

/**
 * reset-after-loss 挑战协议。
 *
 * - reset-challenges：认证用户发起，向已验证邮箱发邮件挑战；对 active/none/abandoned
 *   恒同响应（防枚举）；按 user+IP 各自每小时 3 次限流。token 仅存 SHA-256，24h 单次消费，
 *   重发作废旧 token。
 * - reset-after-loss：单 tx 验证→消费 token→旧 epoch records 逐个 tombstone→建新 epoch
 *   active（无 state 时按 init 语义建 keyEpoch=1）。
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
  ) {}

  async requestResetChallenge(userId: number, ip?: string): Promise<void> {
    await this.rateLimiter.hit(`syncreset:user:${userId}`, RESET_CHALLENGE_WINDOW_S, RESET_CHALLENGE_MAX);
    await this.rateLimiter.hit(`syncreset:ip:${ip ?? 'unknown'}`, RESET_CHALLENGE_WINDOW_S, RESET_CHALLENGE_MAX);

    const user = await this.userRepo.findById(userId);
    // 仅向已验证邮箱发挑战；未验证则不发信、不建 token，仍同形返回（防枚举）。
    if (!user || !user.emailVerifiedTime) return;

    const token = randomBytes(32);
    const tokenHash = hashResetToken(token);
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

  async resetAfterLoss(userId: number, input: ResetAfterLossInput): Promise<{ keyEpoch: string; stateVersion: string; changeSequence: string }> {
    validateNewState(input.newState);
    const tokenHash = hashResetToken(input.resetToken);

    return this.runner(async (tx) => {
      const token = await this.resetTokenRepo.findUsableForUpdate(tx, tokenHash);
      // 不存在/过期/已消费/已撤销/他用户：恒同 400 code+body（防枚举）。
      if (!token || token.userId !== userId) throw new ValidationError('reset token invalid');
      const consumed = await this.resetTokenRepo.consume(tx, token.id, new Date());
      if (!consumed) throw new ValidationError('reset token invalid');

      const state = await this.stateRepo.lockByUserId(tx, userId);
      const now = new Date();

      if (state) {
        // 旧 epoch records 逐个 tombstone（change_sequence 全局单调，§7.3）。
        let seq = state.changeSequence;
        const active = await this.recordRepo.listActiveByEpoch(tx, userId, state.keyEpoch);
        for (const r of active) {
          seq = incU64(seq);
          const ok = await this.recordRepo.softDelete(tx, userId, state.keyEpoch, r.recordId, r.version, incU64(r.version), seq, now);
          if (!ok) throw new SyncVersionConflictError(r.version);
        }
        const next = toState(userId, incU64(state.keyEpoch), '1', seq, input.newState, now);
        const updated = await this.stateRepo.update(tx, userId, state.stateVersion, next);
        if (!updated) throw new SyncVersionConflictError(state.stateVersion);
        return { keyEpoch: next.keyEpoch, stateVersion: next.stateVersion, changeSequence: next.changeSequence };
      }

      // 无 active state：按 init 语义建 keyEpoch=1（对 reset-challenges「none」的对称处理）。
      const next = toState(userId, '1', '1', '0', input.newState, now);
      const created = await this.stateRepo.create(tx, next);
      if (!created) throw new SyncStateExistsError();
      return { keyEpoch: next.keyEpoch, stateVersion: next.stateVersion, changeSequence: next.changeSequence };
    });
  }
}
