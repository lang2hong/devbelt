import type { FastifyInstance } from 'fastify';
import { authScope, type GetAuthUser } from '../middleware/requireAuth.js';
import type { TokenService } from '../service/tokenService.js';
import { sendError } from '../middleware/errorHandler.js';
import type { IDeviceRepo } from '../repository/interfaces.js';
import { deviceIdParam } from './schemas.js';

export interface PersonalRouteOptions {
  tokenService: TokenService;
  getUser: GetAuthUser;
  deviceRepo: IDeviceRepo;
  revokeDevice: (userId: number, deviceId: number) => Promise<{ ok: true }>;
}

/** 本人设备列表 / 撤销（需认证）。实施规格 §5.2。 */
export async function personalRoutes(app: FastifyInstance, opts: PersonalRouteOptions): Promise<void> {
  app.register(authScope, {
    tokenService: opts.tokenService,
    getUser: opts.getUser,
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
        const userId = (req as any).authUserId as number;
        const deviceId = Number((req.params as any).deviceId);
        try {
          const r = await opts.revokeDevice(userId, deviceId);
          reply.send(r);
        } catch (e) {
          sendError(reply, e);
        }
      });
    },
  });
}