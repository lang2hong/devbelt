import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import mysql from '@fastify/mysql';
import sensible from '@fastify/sensible';
import { config } from './config';
import { initDatabase } from './db';
import { authRoutes } from './routes/auth';
import { syncRoutes } from './routes/sync';

/**
 * 同步服务主入口。
 * Fastify 5 + MySQL + JWT，提供认证与同步接口。
 */
async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });
  app.register(sensible);
  app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtExpiresIn } });
  app.register(mysql, { connectionString: authString() });

  // 暴露 jwtSecret 供密码哈希复用
  app.decorate('jwtSecret', config.jwtSecret);

  // 初始化表结构
  await initDatabase(app);

  // 注册路由
  await app.register(authRoutes);
  await app.register(syncRoutes);

  // 健康检查
  app.get('/health', async () => ({ status: 'ok' }));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Sync server listening on :${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

/** 构造 MySQL 连接串 */
function authString(): string {
  const { mysql } = config;
  return `mysql://${mysql.user}:${encodeURIComponent(mysql.password)}@${mysql.host}:${mysql.port}`;
}

main();