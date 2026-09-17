import type { FastifyRequest } from 'fastify';
import type { GetAuthUser } from '../../middleware/requireAuth.js';
import { isConsoleAudience } from '../../middleware/consoleWrite.js';
import type { TokenService } from '../../service/tokenService.js';
import { validateIdempotencyKey } from '../../service/idempotencyService.js';
import type { IdempotencyService } from '../../service/idempotencyService.js';
import type { OrganizationService, InviteOutcome } from '../../service/organizationService.js';
import type { OrganizationResourceService } from '../../service/organizationResourceService.js';
import type { IOrganizationRepo, IMembershipRepo } from '../../repository/interfaces.js';
import type { CsrfService } from '../../service/csrfService.js';
import type { AuditWriter } from '../../service/auditWriter.js';

export interface OrganizationRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  csrfService: CsrfService;
  consoleOrigin: string;
  organizationService: OrganizationService;
  resourceService: OrganizationResourceService;
  organizationRepo: IOrganizationRepo;
  membershipRepo: IMembershipRepo;
  auditWriter: AuditWriter;
  idempotencyService: IdempotencyService;
  /** 邀请邮件发送（提交后副作用；由 app.ts 注入 emailSender）。 */
  sendInvitation: (outcome: InviteOutcome) => Promise<void>;
}

/** 关闭组织回执保留 30 天（§6.1）。 */
export const CLOSE_ORG_RETENTION_MS = 30 * 24 * 3600 * 1000;

type IdempotencyMode = { mode: 'direct' } | { mode: 'key'; idempotencyKey: string };

export function idempotencyMode(req: FastifyRequest): IdempotencyMode {
  const rawKey = req.headers['idempotency-key'];
  if (isConsoleAudience(req) || rawKey !== undefined) {
    return { mode: 'key', idempotencyKey: validateIdempotencyKey(rawKey) };
  }
  return { mode: 'direct' };
}

export function sessionIdOf(req: FastifyRequest): string {
  return (req as unknown as { authSessionId?: string }).authSessionId ?? '';
}

export function requestIdOf(req: FastifyRequest): string {
  return (req as unknown as { requestId?: string }).requestId ?? 'unknown';
}

/** 各路由子模块共享的依赖（同名解构，使搬移的处理函数无需改写内部引用）。 */
export interface OrgRoutesContext {
  svc: OrganizationService;
  resources: OrganizationResourceService;
  opts: OrganizationRouteOptions;
}