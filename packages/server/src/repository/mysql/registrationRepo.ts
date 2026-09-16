import type { IRegistrationRepo, RegistrationAccountInput, RegistrationResult } from '../interfaces.js';
import { withTransaction, type MysqlDb } from './db.js';
import { ConflictError } from '../../domain/errors.js';

/**
 * 注册账号仓储：单事务原子创建 user + Free 订阅 + 邮箱验证 token。
 *
 * 三张表任一失败整体回滚，避免「有 user 无订阅 / 无验证 token」的半套状态。
 * Free 套餐 id 在事务内按 code 从统一 `plans` 查询；缺失即报错（baseline 必须先播种）。
 * 权益不落库（读取时由 plan 派生），订阅只引用 plan。
 */
export class MysqlRegistrationRepo implements IRegistrationRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async createAccount(input: RegistrationAccountInput): Promise<RegistrationResult> {
    return withTransaction(this.db(), async (tx) => {
      const [planRows] = await tx.query<any[]>(
        "SELECT id FROM plans WHERE code = 'free' AND kind = 'personal' AND status = 'active' LIMIT 1",
      );
      const freePlan = planRows[0];
      if (!freePlan) throw new Error('free plan is missing; run migrations before register');

      let userId: number;
      try {
        const [userResult] = await tx.query<any>(
          `INSERT INTO users (email, password_hash, display_name, status)
           VALUES (?, ?, ?, 'active')`,
          [input.email, input.passwordHash, input.displayName ?? null],
        );
        userId = Number(userResult.insertId);
      } catch (err: any) {
        // 并发注册穿透前置检查后撞唯一键 → 409（非 500）
        if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
          throw new ConflictError(`user already exists: ${input.email}`);
        }
        throw err;
      }

      const now = new Date();
      await tx.query(
        `INSERT INTO personal_subscriptions (user_id, plan_id, status, period_start_time, period_end_time)
         VALUES (?, ?, 'active', ?, NULL)`,
        [userId, freePlan.id, now],
      );

      await tx.query(
        `INSERT INTO email_verification_tokens (user_id, email, purpose, token_hash, expires_time)
         VALUES (?, ?, 'initial', ?, ?)`,
        [userId, input.email, input.verificationTokenHash, input.verificationExpiresTime],
      );

      return { userId };
    });
  }
}