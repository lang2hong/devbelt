import { hashPassword } from '../../service/password.js';
import { withTransaction, type MysqlDb, type MysqlTx } from './db.js';

export interface BootstrapAdminInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface BootstrapAdminResult {
  userId: number;
  organizationId: number;
}

/**
 * 在空的 v2 数据库中创建唯一的初始系统管理员。
 *
 * 该操作刻意不写入 migration：管理员凭据是部署环境状态，不是 schema 状态。
 * 所有行在同一事务中创建，避免半成品管理员（有 user 无 personal org 或订阅）。
 */
export async function bootstrapInitialAdmin(
  db: MysqlDb,
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email');
  if (input.password.length < 8) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 8 chars');

  return withTransaction(db, async (tx) => createInitialAdmin(tx, {
    email,
    password: input.password,
    displayName: input.displayName?.trim() || undefined,
  }));
}

async function createInitialAdmin(tx: MysqlTx, input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
  const [existingRows] = await tx.query<any[]>('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email]);
  if (existingRows.length > 0) throw new Error(`user already exists: ${input.email}`);

  const [planRows] = await tx.query<any[]>('SELECT id FROM plans WHERE code = ? LIMIT 1', ['free']);
  const freePlan = planRows[0];
  if (!freePlan) throw new Error('free plan is missing; run migrations before bootstrap');

  const [userResult] = await tx.query<any>(
    `INSERT INTO users (email, password_hash, display_name, role, status)
     VALUES (?, ?, ?, 'admin', 'active')`,
    [input.email, hashPassword(input.password), input.displayName ?? null],
  );
  const userId = Number(userResult.insertId);

  const orgName = input.displayName ? `${input.displayName}'s workspace` : `${input.email}'s workspace`;
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
  await tx.query(
    `INSERT INTO seats (subscription_id, organization_id, status)
     VALUES (?, ?, 'active')`,
    [Number(subscriptionResult.insertId), organizationId],
  );

  return { userId, organizationId };
}
