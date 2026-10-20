import type { Device } from '../../../domain/entities.js';
import type { TokenAudience } from '../../../domain/enums.js';
import { UnauthorizedError, UserDisabledError } from '../../../domain/errors.js';
import type { IDeviceRepo, IRefreshTokenRepo, IUserRepo } from '../../../repository/interfaces.js';
import type { TxRunner } from '../../../repository/mysql/db.js';
import type { AuditEventType, AuditWriter } from '../../../service/auditWriter.js';
import type { TokenService } from '../../../service/tokenService.js';

/**
 * 刷新 token 复用宽限（扩展 / 控制台同口径）。
 *
 * 最近才被撤销、且族内仍有活跃 token → 视为并发/重试重放，只拒绝本次；
 * 超出宽限才判定为真·复用并吊销整族。
 */
export const REFRESH_REUSE_GRACE_MS = 60_000;

/**
 * 两个入口的差异点集中在这里：audience/scope、设备绑定谓词、复用审计事件、
 * 登出撤销范围。轮换/复用/锁顺序等共同逻辑留在 SessionRotationService。
 */
export interface SessionPolicy {
  audience: TokenAudience;
  scope: readonly string[];
  /** 设备绑定校验；false → UnauthorizedError('device mismatch')。 */
  allowDevice(bound: Device, deviceKey?: string): boolean;
  /** 真·复用时写入的审计事件类型。 */
  reuseAuditEvent: AuditEventType;
  /** 扩展登出只撤销当前 token；控制台登出撤销整个 family。 */
  logoutScope: 'token' | 'family';
}

export interface SessionRotationDeps {
  userRepo: IUserRepo;
  deviceRepo: IDeviceRepo;
  refreshTokenRepo: IRefreshTokenRepo;
  tokenService: TokenService;
  runner: TxRunner;
  auditWriter?: AuditWriter;
}

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * 会话轮换：扩展（aud=extension）与控制台（aud=console）共用的 refresh/logout 实现。
 *
 * 事务与锁顺序固定为 `user → device → token`（与 login / revokeDevice 一致），
 * 差异全部由调用方传入的 SessionPolicy 决定。
 */
export class SessionRotationService {
  constructor(private readonly deps: SessionRotationDeps) {}

  async refresh(refreshTokenStr: string, policy: SessionPolicy, deviceKey?: string): Promise<RotatedTokens> {
    const { userRepo, deviceRepo, refreshTokenRepo, tokenService, runner, auditWriter } = this.deps;
    const tokenHash = tokenService.hashToken(refreshTokenStr);
    const pre = await refreshTokenRepo.findByHash(tokenHash);
    if (!pre || pre.deviceId === null) throw new UnauthorizedError();
    // 闭包里 TS 不保留属性 narrow，先固化为本地 number
    const preUserId = pre.userId;
    const preDeviceId = pre.deviceId;

    const outcome = await runner(
      async (tx): Promise<{ kind: 'rotated'; accessToken: string; refreshToken: string } | { kind: 'reuse'; familyId: string; revokedTime: Date }> => {
        // 统一锁顺序 user -> device -> token（与 login / revokeDevice 一致，避免死锁）。
        const user = await userRepo.lockById(tx, preUserId);
        if (!user) throw new UnauthorizedError();
        if (user.status !== 'active') throw new UserDisabledError(user.id);

        // 设备绑定校验（§5.1）：锁 device 行，要求其 active、归属、且满足入口策略。
        const bound = await deviceRepo.findByIdForUpdate(tx, preDeviceId);
        if (!bound || bound.userId !== user.id || bound.status !== 'active' || !policy.allowDevice(bound, deviceKey)) {
          throw new UnauthorizedError('device mismatch');
        }
        await deviceRepo.touch(tx, bound.id, new Date());

        const now = new Date();
        const rt = await refreshTokenRepo.findByHashForUpdate(tx, tokenHash);
        if (!rt || rt.expiresTime <= now) throw new UnauthorizedError();
        if (rt.revokedTime) {
          return { kind: 'reuse', familyId: rt.familyId, revokedTime: rt.revokedTime };
        }

        await refreshTokenRepo.consume(tx, rt.id, now);
        const { token, hash, expiresAt } = tokenService.generateRefreshToken();
        await refreshTokenRepo.create(tx, {
          userId: user.id,
          deviceId: rt.deviceId,
          tokenHash: hash,
          familyId: rt.familyId,
          expiresTime: expiresAt,
        });

        const accessToken = await tokenService.signAccessToken({
          userId: user.id,
          aud: policy.audience,
          scope: [...policy.scope],
          sessionId: rt.familyId,
          deviceId: rt.deviceId ?? undefined,
          sessionVersion: user.sessionVersion,
        });
        return { kind: 'rotated', accessToken, refreshToken: token };
      },
    );

    if (outcome.kind === 'reuse') {
      // 良性重放大赦：旧 token 是**最近**（≤宽限）才被撤销、且族内仍有活跃 token
      // （说明新 token 已签发给合法客户端）。此时并发/重试重放只拒绝本次，不吊销整族；
      // 陈旧客户端下次会从存储读到新 token 自愈。
      const benign = Date.now() - outcome.revokedTime.getTime() <= REFRESH_REUSE_GRACE_MS
        && (await refreshTokenRepo.hasActiveToken(outcome.familyId));
      if (benign) throw new UnauthorizedError('refresh token already rotated');
      // 真·复用检测：在**独立事务**里撤销整族（§5.1）。不能放进上面的轮换事务 ——
      // 那样 throw 会被 withTransaction 回滚，把撤销一起丢掉。
      await runner((tx) => refreshTokenRepo.revokeFamily(tx, outcome.familyId, new Date()));
      // 复用通常意味着凭据被盗/泄漏：作为安全事件落审计（只记元数据，不含 token/hash）。
      auditWriter?.write({
        eventType: policy.reuseAuditEvent,
        result: 'failure',
        actorUserId: preUserId,
        targetType: 'refresh_family',
        targetId: outcome.familyId,
        reason: 'refresh token reuse detected',
      });
      throw new UnauthorizedError('refresh token reuse detected');
    }

    return { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken };
  }

  async logout(refreshTokenStr: string | undefined, policy: SessionPolicy): Promise<{ ok: true }> {
    if (!refreshTokenStr) return { ok: true };
    const { refreshTokenRepo, tokenService, runner } = this.deps;
    const tokenHash = tokenService.hashToken(refreshTokenStr);
    await runner(async (tx) => {
      const rt = await refreshTokenRepo.findByHashForUpdate(tx, tokenHash);
      if (!rt || rt.revokedTime) return;
      if (policy.logoutScope === 'family') {
        await refreshTokenRepo.revokeFamily(tx, rt.familyId, new Date());
      } else {
        await refreshTokenRepo.consume(tx, rt.id, new Date());
      }
    });
    return { ok: true };
  }
}