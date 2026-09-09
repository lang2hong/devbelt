import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import type { AuditWriter } from '../service/auditWriter.js';
import type { CsrfService } from '../service/csrfService.js';
import { sendError } from '../middleware/errorHandler.js';
import { consoleWriteGuard, clearSessionCookies, isConsoleAudience } from '../middleware/consoleWrite.js';
import type { IDeviceRepo } from '../repository/interfaces.js';
import type { Queryable } from '../repository/mysql/db.js';
import { validateIdempotencyKey, type IdempotencyService } from '../service/idempotencyService.js';
import { deviceIdParam } from './schemas.js';

export interface PersonalRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  getSessionActive: (sessionId: string) => Promise<boolean>;
  auditWriter: AuditWriter;
  csrfService: CsrfService;
  consoleOrigin: string;
  deviceRepo: IDeviceRepo;
  idempotencyService: IdempotencyService;
  revokeDevice: (userId: number, deviceId: number) => Promise<{ ok: true }>;
  revokeDeviceInTx: (tx: Queryable, userId: number, deviceId: number) => Promise<{ ok: true }>;
}

/** 本人设备列表 / 撤销（需认证）。实施规格 §5.2。 */
export async function personalRoutes(app: FastifyInstance, opts: PersonalRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
    getSessionActive: opts.getSessionActive,
    aud: ['extension', 'console'],
    scope: ['device'],
    routes: async (child) => {
      child.get('/api/personal/devices', async (req, reply) => {
        const userId = (req as any).authUserId as number;
        try {
          const devices = await opts.deviceRepo.listByUser(userId);
          reply.send({
            devices: devices.map((d) => ({
              deviceId: String(d.id),
              devicePlatform: d.devicePlatform,
              deviceName: d.deviceName,
              clientVersion: d.clientVersion,
              status: d.status,
              lastUsedTime: d.lastUsedTime ? d.lastUsedTime.toISOString() : null,
              createTime: d.createTime.toISOString(),
            })),
          });
        } catch (e) {
          sendError(reply, e);
        }
      });

      child.delete('/api/personal/devices/:deviceId', { schema: { params: deviceIdParam } }, async (req, reply) => {
        if (!consoleWriteGuard(req, opts.csrfService, opts.consoleOrigin)) {
          return reply.code(403).send({ message: 'forbidden', code: 'FORBIDDEN' });
        }
        const userId = (req as any).authUserId as number;
        const deviceId = Number((req.params as any).deviceId);
        const consoleAudience = isConsoleAudience(req);
        const rawKey = req.headers['idempotency-key'];
        const sessionId = (req as unknown as { authSessionId?: string }).authSessionId ?? '';
        const requestId = (req as unknown as { requestId?: string }).requestId ?? 'unknown';
        const currentDevice = (req as unknown as { authDeviceId?: number }).authDeviceId === deviceId;

        try {
          // 扩展端兼容：无 Idempotency-Key 沿用原撤销行为（revoke 天然幂等，无回执）。
          if (!consoleAudience && rawKey === undefined) {
            const r = await opts.revokeDevice(userId, deviceId);
            opts.auditWriter.write({
              eventType: 'auth.device.revoked',
              result: 'success',
              actorUserId: userId,
              targetType: 'device',
              targetId: String(deviceId),
              sourceIp: req.ip,
              requestId,
            });
            if (currentDevice) {
              clearSessionCookies(reply);
              reply.send({ ...r, code: 'CURRENT_SESSION_REVOKED' });
            } else {
              reply.send(r);
            }
            return;
          }

          // Console 写必须带 key（缺失 → 400 平铺 VALIDATION_FAILED）；扩展带 key 走回执。
          const idempotencyKey = validateIdempotencyKey(rawKey);
          const result = await opts.idempotencyService.run({
            actorUserId: userId,
            sessionId,
            method: 'DELETE',
            normalizedPath: `/api/personal/devices/${deviceId}`,
            idempotencyKey,
            business: async (tx) => {
              await opts.revokeDeviceInTx(tx, userId, deviceId);
              await opts.auditWriter.writeInTx(tx, {
                eventType: 'auth.device.revoked',
                result: 'success',
                actorUserId: userId,
                targetType: 'device',
                targetId: String(deviceId),
                sourceIp: req.ip,
                requestId,
              });
              return {
                status: 200,
                body: currentDevice ? { ok: true, code: 'CURRENT_SESSION_REVOKED' } : { ok: true },
              };
            },
          });
          // 撤销的是当前 console 设备 → 立即登出（§6 + §4.2 L131）。首次与重放都清 Cookie，
          // 覆盖首响应丢失后带着已撤销会话 Cookie 重试的情况（Set-Cookie 幂等无害）。
          if (currentDevice) clearSessionCookies(reply);
          reply.code(result.status).send(result.body);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}