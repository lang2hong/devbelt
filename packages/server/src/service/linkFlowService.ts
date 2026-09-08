import { createHash, randomBytes } from 'crypto';
import {
  EmailVerificationAlreadyConfirmedError,
  EmailVerificationInvalidError,
  ValidationError,
} from '../domain/errors.js';
import type { IMailFlowRepo, IEmailVerificationTokenRepo, IUserRepo } from '../repository/interfaces.js';
import type { MailFlow } from '../domain/entities.js';
import type { TxRunner, Queryable } from '../repository/mysql/db.js';
import type { RateLimitService } from './rateLimitService.js';

/** 邮件流短时有效（§5.1：签发后 10 分钟）。 */
const MAIL_FLOW_TTL_MS = 10 * 60 * 1000;

/** 邮箱验证 token 的固定形态：32 字节随机值 base64url 编码 = 43 字符。 */
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

/**
 * 一次性邮件链接服务（P3 §5）：只处理 verify-email 类型（切片 1）。
 *
 * - claim：校验 type/token 形态，幂等认领（同 nonce 复用），签发 opaque nonce，按 IP + token 限流。
 * - verifyEmail：以 nonce 定位 mail_flow，在事务内消费验证 token + 标记邮箱已验。
 *
 * 不认领 sync-reset token、不签发 handoff、不调用同步 API、不处理 newState（切片 5）。
 */
export class LinkFlowService {
  constructor(
    private readonly mailFlowRepo: IMailFlowRepo,
    private readonly emailVerificationTokenRepo: IEmailVerificationTokenRepo,
    private readonly userRepo: IUserRepo,
    private readonly runner: TxRunner,
    private readonly rateLimiter: RateLimitService,
  ) {}

  async claim(args: { type: string; token: string; ip?: string; existingNonce?: string }): Promise<LinkFlowClaimResult> {
    if (args.type !== 'verify-email') {
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
        existing.type === 'verify-email' &&
        existing.status === 'issued' &&
        existing.expiresTime > now &&
        existing.targetTokenHash.equals(targetTokenHash)
      ) {
        return { nonce: args.existingNonce, created: false };
      }
    }

    const tokenRecord = await this.emailVerificationTokenRepo.findByHash(tokenHashHex);

    const nonce = randomBytes(32).toString('base64url');
    const expiresTime = new Date(now.getTime() + MAIL_FLOW_TTL_MS);
    await this.mailFlowRepo.create({
      type: 'verify-email',
      targetTokenHash,
      targetRecordId: tokenRecord ? tokenRecord.id : null,
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