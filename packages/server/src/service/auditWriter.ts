import type { AuditEvent } from '../domain/entities.js';
import type { IAuditRepo } from '../repository/interfaces.js';
import type { Queryable } from '../repository/mysql/db.js';
import { isIP } from 'net';

/**
 * 审计事件可写类型白名单（P3 §9）。
 *
 * 白名单之外的事件类型一律丢弃并告警，杜绝把未评审字段写进审计表。
 * 切片 1 只覆盖「身份与邮件」类：邮箱验证消费成功/失败、验证重发。
 */
const ALLOWED_EVENT_TYPES = [
  'email.verify.consumed',
  'email.verify.failed',
  'email.verification.resend',
  'auth.login.success',
  'auth.login.failed',
  'auth.logout',
  'auth.password.changed',
  'auth.device.revoked',
  'account.displayName.changed',
  'organization.created',
  'organization.renamed',
  'invitation.create',
  'invitation.revoke',
  'invitation.accept',
  'organization.member.role_changed',
  'organization.member.removed',
  'organization.member.left',
  'organization.closed',
  'organization.member_email.read',
  'system.receipts.cleanup',
  'admin.users.read',
  'admin.user.disabled',
  'admin.user.enabled',
  'admin.user.subscription.changed',
  'admin.organizations.read',
  'admin.organization.subscription.changed',
  'admin.audit.read',
  'admin.audit.export',
  'admin.role.granted',
  'sync.reset.handoff.created',
  'sync.reset.handoff.consumed',
  'sync.reset.handoff.failed',
  'payment.order.created',
  'payment.order.paid',
  'payment.order.fulfilled',
  'payment.callback.failed',
  'invoice.requested',
  'console.auth.refresh.reuse',
] as const;

export type AuditEventType = (typeof ALLOWED_EVENT_TYPES)[number];

export interface AuditWriteInput {
  eventType: AuditEventType;
  result: 'success' | 'failure';
  failureCode?: string | null;
  actorUserId?: number | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  organizationId?: number | null;
  sourceIp?: string | null;
  requestId?: string | null;
  reason?: string | null;
}

/**
 * 审计写入器：只接收显式字段（永不接触原始 token/密码等敏感值），按白名单过滤后
 * 以 append-only 方式落库。写入失败只记日志、不向上抛 —— 审计失败不得阻断主流程
 * （`writeInTx` 除外：事务内审计随业务提交，失败应使整个事务回滚）。
 */
export class AuditWriter {
  constructor(
    private readonly repo: IAuditRepo,
    private readonly log: (msg: string, data?: unknown) => void = () => {},
  ) {}

  write(input: AuditWriteInput): void {
    const event = this.build(input);
    if (!event) return;
    // 异步写入：审计落库失败不应改变或阻断主流程。
    void this.repo.insert(event).catch((err) => {
      this.log('audit write failed', { eventType: input.eventType, err: String(err) });
    });
  }

  /** 事务内写入（幂等回执下审计与业务写同事务、重放不重复审计）。 */
  async writeInTx(exec: Queryable, input: AuditWriteInput): Promise<void> {
    const event = this.build(input);
    if (!event) return;
    await this.repo.insertInTx(exec, event);
  }

  private build(input: AuditWriteInput): Omit<AuditEvent, 'id' | 'createTime'> | null {
    if (!(ALLOWED_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
      this.log('audit event type not whitelisted, dropped', { eventType: input.eventType });
      return null;
    }

    return {
      eventTime: new Date(),
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      eventType: input.eventType,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      organizationId: input.organizationId ?? null,
      sourceIp: redactIp(input.sourceIp),
      requestId: input.requestId ?? null,
      result: input.result,
      failureCode: input.failureCode ?? null,
      reason: input.reason ?? null,
    };
  }
}

/**
 * 来源 IP 脱敏（§9「脱敏 sourceIp」）：基于地址解析而非分隔符计数。
 * - IPv4：末段置 0。
 * - IPv6：展开为 8 组后保留前 4 组（含压缩形与 IPv4 映射形）。
 * `X-Forwarded-For` 多值列表形态（含逗号）取第一段；无法识别时按原样保守返回。
 */
export function redactIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const value = ip.split(',')[0].trim();

  const kind = isIP(value);
  if (kind === 4) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (kind === 6) {
    const groups = expandIpv6(value);
    return `${groups.slice(0, 4).join(':')}::`;
  }
  return value;
}

function expandIpv6(addr: string): string[] {
  const doubleColon = addr.indexOf('::');
  if (doubleColon === -1) return splitHextets(addr);

  const head = addr.slice(0, doubleColon);
  const tail = addr.slice(doubleColon + 2);
  const headGroups = head ? splitHextets(head) : [];
  const tailGroups = tail ? splitHextets(tail) : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  return [...headGroups, ...new Array(missing).fill('0'), ...tailGroups];
}

function splitHextets(part: string): string[] {
  const groups = part.split(':');
  const last = groups[groups.length - 1];
  if (last && last.includes('.')) {
    return [...groups.slice(0, -1), ...ipv4ToHextets(last)];
  }
  return groups;
}

function ipv4ToHextets(v4: string): string[] {
  const octets = v4.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n))) return [v4];
  return [((octets[0] * 256) + octets[1]).toString(16), ((octets[2] * 256) + octets[3]).toString(16)];
}