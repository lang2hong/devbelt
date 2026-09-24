import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConsoleStatic, BASE_CSP } from '../../src/consoleStatic.js';

const ENV_KEYS = ['DEVBELT_DB_AUTH_DIST_DIR', 'DEVBELT_DB_CONSOLE_DIST_DIR', 'DEVBELT_DB_ADMIN_DIST_DIR'] as const;

let root = '';
let app: FastifyInstance;
let saved: Record<string, string | undefined> = {};

function writeDist(dir: string, files: string[]): void {
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const f of files) writeFileSync(path.join(dir, f), '<html>ok</html>');
}

function cspOf(res: { headers: Record<string, unknown> }): string {
  return String(res.headers['content-security-policy'] ?? '');
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'devbelt-csp-'));
  const auth = path.join(root, 'auth');
  const con = path.join(root, 'con');
  const admin = path.join(root, 'admin');
  writeDist(auth, ['index.html', 'login.html', 'register.html', 'verify-email.html']);
  writeDist(con, ['index.html', 'sync-reset.html']);
  writeDist(admin, ['index.html']);

  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DEVBELT_DB_AUTH_DIST_DIR = auth;
  process.env.DEVBELT_DB_CONSOLE_DIST_DIR = con;
  process.env.DEVBELT_DB_ADMIN_DIST_DIR = admin;

  app = Fastify();
  await registerConsoleStatic(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('CSP 按路径收窄（P6-S5b 后续）', () => {
  it('/db/（控制台 SPA）放行 wasm-unsafe-eval 与 worker-src', async () => {
    const res = await app.inject({ method: 'GET', url: '/db/' });
    expect(res.statusCode).toBe(200);
    const csp = cspOf(res);
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self'");
  });

  it('/db/sync-reset（db-ui 入口）同样放行', async () => {
    const res = await app.inject({ method: 'GET', url: '/db/sync-reset' });
    expect(res.statusCode).toBe(200);
    expect(cspOf(res)).toContain("worker-src 'self'");
  });

  it('/db/* SPA fallback 同样放行', async () => {
    const res = await app.inject({ method: 'GET', url: '/db/account/authenticator' });
    expect(res.statusCode).toBe(200);
    expect(cspOf(res)).toContain("worker-src 'self'");
  });

  it('/login 等身份页不放行 wasm/worker', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    const csp = cspOf(res);
    expect(csp).toBe(BASE_CSP);
    expect(csp).not.toContain('wasm');
    expect(csp).not.toContain('worker-src');
  });

  it('/db/docs（服务端渲染文档）不放行 wasm/worker', async () => {
    const res = await app.inject({ method: 'GET', url: '/db/docs' });
    expect(res.statusCode).toBe(200);
    const csp = cspOf(res);
    expect(csp).toBe(BASE_CSP);
    expect(csp).not.toContain('worker-src');
  });
});
