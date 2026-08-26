import type { IRegistrationRepo, RegistrationAccountInput, RegistrationResult } from '../interfaces.js';
import { withTransaction, type MysqlDb } from './db.js';
import { AlreadyExistsError } from '../../domain/errors.js';

/**
 * 注册账号仓储：原子创建 user + personal org + admin membership + free 订阅 + 席位。
 *
 * 五张表在同一事务内写入，任一失败整体回滚，避免「有 user 无 personal org /
 * 订阅」的半套状态。与 bootstrapAdmin.createInitialAdmin 同构，只是 role /
 * displayName 参数化（注册是 'user'，bootstrap 是 'admin'）。
 *
 * free 套餐 id 在事务内按 code 查询；不存在即报错（migration 002 必须先播种）。
 */
export class MysqlRegistrationRepo implements IRegistrationRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async createAccount(input: RegistrationAccountInput): Promise<RegistrationResult> {
    return withTransaction(this.db(), async (tx) => {
      const [existing] = await tx.query<any[]>('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email]);
      if (existing.length > 0) throw new AlreadyExistsError(`user already exists: ${input.email}`);

      const [planRows] = await tx.query<any[]>('SELECT id FROM plans WHERE code = ? LIMIT 1', ['free']);
      const freePlan = planRows[0];
      if (!freePlan) throw new Error('free plan is missing; run migrations before register');

      let userId: number;
      try {
        const [userResult] = await tx.query<any>(
          `INSERT INTO users (email, password_hash, display_name, role, status)
           VALUES (?, ?, ?, ?, 'active')`,
          [input.email, input.passwordHash, input.displayName ?? null, input.role],
        );
        userId = Number(userResult.insertId);
      } catch (err: any) {
        // A7: 并发注册穿透预检查后撞唯一键 → 409（非 500）
        if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) throw new AlreadyExistsError(`user already exists: ${input.email}`);
        throw err;
      }

      // A6: 截断 org name 至 100 字符（"'s workspace" = 12 字符，baseName ≤ 88）
      const baseName = input.displayName || input.email;
      const orgName = `${baseName.substring(0, 88)}'s workspace`;
      const [orgResult] = await tx.query<any>(
        `INSERT INTO organizations (name, type, owner_user_id, status)
         VALUES (?, 'personal', ?, 'active')`,
        [orgName, userId],
      );
      const organizationId = Number(orgResult.insertId);

      await tx.query(
        `INSERT INTO memberships (organization_id, user_id, role, status)
         VALUES (?, ?, 'admin', 'active')`,
        [organizationId, userId],
      );
      const [subscriptionResult] = await tx.query<any>(
        `INSERT INTO subscriptions (organization_id, plan_id, status, provider)
         VALUES (?, ?, 'active', 'manual')`,
        [organizationId, freePlan.id],
      );
      const subscriptionId = Number(subscriptionResult.insertId);

      await tx.query(
        `INSERT INTO seats (subscription_id, organization_id, status)
         VALUES (?, ?, 'active')`,
        [subscriptionId, organizationId],
      );

      return { userId, organizationId, subscriptionId };
    });
  }
}