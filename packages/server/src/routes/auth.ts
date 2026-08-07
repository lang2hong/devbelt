import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../db';

/**
 * 认证路由：注册 / 登录。
 * 使用 @fastify/jwt 签发 token，payload 携带 sub(用户ID) 与 role(角色)。
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 注册
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.code(400).send({ message: 'email and password required' });
    }
    if (password.length < 8) {
      return reply.code(400).send({ message: 'password must be at least 8 chars' });
    }

    const [exist] = await app.mysql.query<any[]>(
      'SELECT id FROM users WHERE email = ?',
      [email],
    );
    if (exist.length > 0) {
      return reply.code(409).send({ message: 'email already registered' });
    }

    const passwordHash = hashPassword(password, app.jwtSecret);
    const result = await app.mysql.query(
      'INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [email, passwordHash, 'user'],
    );
    const userId = (result as any).insertId;
    const token = app.jwt.sign({ sub: userId, role: 'user' });
    return reply.code(201).send({ token, userId, role: 'user' });
  });

  // 登录
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return reply.code(400).send({ message: 'email and password required' });
    }

    const passwordHash = hashPassword(password, app.jwtSecret);
    const rows = await app.mysql.query(
      'SELECT id, role FROM users WHERE email = ? AND password_hash = ?',
      [email, passwordHash],
    );
    const user = (rows as any[])[0];
    if (!user) {
      return reply.code(401).send({ message: 'invalid credentials' });
    }

    const token = app.jwt.sign({ sub: user.id, role: user.role });
    return reply.send({ token, userId: user.id, role: user.role });
  });
}