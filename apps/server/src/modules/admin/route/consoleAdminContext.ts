import type { FastifyRequest } from 'fastify';
import type { GetAuthUser } from '../../../middleware/requireAuth.js';
import { validateIdempotencyKey, type IdempotencyService } from '../../../service/idempotencyService.js';
import type { ConsoleAdminService } from '../service/consoleAdminService.js';
import type { CursorService } from '../../../service/cursor.js';
import type { TokenService } from '../../../service/tokenService.js';
import type { CsrfService } from '../../../service/csrfService.js';
import type { RateLimitService } from '../../../service/rateLimitService.js';
import type { Queryable } from '../../../repository/mysql/db.js';
import type { AdminUserRow } from '../../../repository/interfaces.js';
import type { Order, Invoice, Plan } from '../../../domain/entities.js';
import type { IPlanRepo } from '../../../repository/interfaces.js';
import { ValidationError } from '../../../domain/errors.js';

/** 高危平台写回执保留 30 天（§6.1）。 */
export const ADMIN_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** 平台端点按调用者限流（§6）：查询 60/min、写 30/min、导出 10/h。 */
export const RATE_READ_WINDOW_S = 60;
export const RATE_READ_MAX = 60;
export const RATE_WRITE_WINDOW_S = 60;
export const RATE_WRITE_MAX = 30;
export const RATE_EXPORT_WINDOW_S = 3600;
export const RATE_EXPORT_MAX = 10;

export interface ConsoleAdminRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  rateLimiter: RateLimitService;
  idempotencyService: IdempotencyService;
  adminService: ConsoleAdminService;
  cursorService: CursorService;
  /** 套餐缓存：PATCH 提交后失效（闭合「提交前失效」竞态窗口）。 */
  planRepo: IPlanRepo;
  serverVersion: string;
  consoleApiVersion: string;
}

/** 子路由共享的上下文：options、service 与三类限流器。 */
export interface AdminCtx {
  opts: ConsoleAdminRouteOptions;
  svc: ConsoleAdminService;
  readLimit: (req: FastifyRequest) => Promise<void>;
  writeLimitInTx: (tx: Queryable, req: FastifyRequest) => Promise<void>;
  exportLimitInTx: (tx: Queryable, req: FastifyRequest) => Promise<void>;
}

export function userIdOf(req: FastifyRequest): number {
  return (req as unknown as { authUserId: number }).authUserId;
}

export function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}

/** 平台写：Origin 同源 + 会话绑定 CSRF + Idempotency-Key（validate 缺失即抛 validation）。 */
export function adminWriteKey(req: FastifyRequest): string {
  return validateIdempotencyKey(req.headers['idempotency-key']);
}

export function parseCursor(cursorService: CursorService, raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  const decoded = cursorService.decode(raw);
  if (decoded === null) return null;
  const n = Number(decoded);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : 50;
  if (!Number.isInteger(n) || n <= 0) return 50;
  return Math.min(n, 100);
}

export function parseDate(raw: unknown): Date | undefined {
  if (raw === undefined || raw === '' || raw === null) return undefined;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new ValidationError('invalid date');
  return d;
}

export function iso(v: Date | null): string | null {
  return v ? v.toISOString() : null;
}

export function userDto(r: AdminUserRow) {
  return {
    userId: String(r.userId),
    email: r.email,
    emailVerified: !!r.emailVerifiedTime,
    displayName: r.displayName ?? null,
    status: r.status,
    role: r.role,
    lastLoginTime: iso(r.lastLoginTime),
    planCode: r.planCode,
    deviceCount: r.deviceCount,
    subscriptionVersion: r.subscriptionVersion,
    periodEndTime: iso(r.periodEndTime),
    createTime: r.createTime.toISOString(),
  };
}

export const ORDER_STATUSES: readonly string[] = ['pending', 'paid', 'fulfilled', 'failed', 'refunded', 'expired'];
export const INVOICE_STATUSES: readonly string[] = ['requested', 'issued', 'rejected', 'failed'];

export function adminOrderDto(o: Order & { userEmail?: string | null; userDisplayName?: string | null }) {
  return {
    orderNo: o.orderNo,
    userId: String(o.userId),
    userEmail: o.userEmail ?? null,
    userDisplayName: o.userDisplayName ?? null,
    purpose: o.purpose,
    planCode: o.planCode,
    skuCode: o.skuCode ?? null,
    amountCents: o.amountCents,
    channel: o.channel,
    status: o.status,
    channelTradeNo: o.channelTradeNo ?? null,
    paidTime: iso(o.paidTime),
    expiresTime: o.expiresTime.toISOString(),
    createTime: o.createTime.toISOString(),
    updateTime: o.updateTime.toISOString(),
  };
}

export function adminInvoiceDto(inv: Invoice) {
  return {
    invoiceId: String(inv.id),
    userId: String(inv.userId),
    title: inv.title,
    taxNo: inv.taxNo ?? null,
    email: inv.email,
    amountCents: inv.amountCents,
    status: inv.status,
    reason: inv.reason ?? null,
    createTime: inv.createTime.toISOString(),
  };
}

/** 管理端套餐 DTO（含 version 与特性取值）。 */
export function adminPlanDto(p: Plan) {
  return {
    id: p.id, code: p.code, kind: p.kind, name: p.name, priceCents: p.priceCents,
    billingUnit: p.billingUnit, sortOrder: p.sortOrder, status: p.status, version: p.version,
    features: p.features,
  };
}