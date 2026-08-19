import type { FastifyJWT } from '@fastify/jwt';

/**
 * Fastify 插件类型增强：
 * 让 TS 识别 app.mysql（@fastify/mysql）与 jwtSecret 等自定义属性。
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** @fastify/mysql 注入的 MySQL 连接池（promise 模式） */
    mysql: import('../repository/mysql/db.js').MysqlDb;
    /** JWT 签名密钥（来自配置） */
    jwtSecret: string;
  }

  interface FastifyRequest {
    /** 认证后的 JWT 载荷 */
    user: FastifyJWT['user'];
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** 签名载荷：sub 为用户 id，role 用于 RBAC；plan 套餐；sid 为当前 refresh token 主键（标记当前设备） */
    user: { sub: number; role: string; plan?: string; sid?: number };
  }
}