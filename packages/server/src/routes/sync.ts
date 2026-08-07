import type { FastifyInstance } from 'fastify';

/**
 * 同步路由：拉取 / 推送用户的加密数据体。
 * 需认证；数据按 sub(userId) 隔离，每个用户只能操作自己的数据。
 */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // 注册鉴权前置钩子：所有 /api/sync 请求必须携带有效 JWT
  app.addHook('onRequest', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'unauthorized' });
    }
  });

  // 拉取当前用户同步数据
  app.get('/api/sync', async (req) => {
    const userId = req.user.sub as number;
    const rows = await app.mysql.query(
      'SELECT data, version FROM sync_data WHERE user_id = ?',
      [userId],
    );
    const row = (rows as any[])[0];
    if (!row) {
      return { data: null, version: 0 };
    }
    return { data: row.data, version: row.version };
  });

  // 推送当前用户同步数据（乐观锁：校验 version）
  app.put('/api/sync', async (req, reply) => {
    const userId = req.user.sub as number;
    const { data, baseVersion } = req.body as { data?: string; baseVersion?: number };
    if (typeof data !== 'string') {
      return reply.code(400).send({ message: 'data must be a string' });
    }

    const rows = await app.mysql.query(
      'SELECT version FROM sync_data WHERE user_id = ?',
      [userId],
    );
    const row = (rows as any[])[0];
    const currentVersion = row ? row.version : 0;

    // 冲突检测：客户端基于的版本与服务端当前版本不一致则拒绝
    if (row && baseVersion !== undefined && baseVersion !== currentVersion) {
      return reply.code(409).send({ message: 'conflict', version: currentVersion });
    }

    const newVersion = currentVersion + 1;
    if (row) {
      await app.mysql.query(
        'UPDATE sync_data SET data = ?, version = ? WHERE user_id = ?',
        [data, newVersion, userId],
      );
    } else {
      await app.mysql.query(
        'INSERT INTO sync_data (user_id, data, version) VALUES (?, ?, ?)',
        [userId, data, newVersion],
      );
    }
    return reply.send({ version: newVersion });
  });
}