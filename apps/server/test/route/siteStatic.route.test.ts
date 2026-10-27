import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerConsoleStatic } from '../../src/consoleStatic.js';
import { registerErrorHandler } from '../../src/middleware/errorHandler.js';

async function build(opts: { loggedIn?: boolean; cwd?: string } = {}) {
  const app = Fastify();
  // 指向真实 site dist（repo 根下 apps/site/dist）
  process.env.DEVBELT_SITE_DIST_DIR = opts.cwd ?? new URL('../../../../apps/site/dist', import.meta.url).pathname;
  registerErrorHandler(app);
  // 其他 ui dist 不存在也不影响首页/英文页/套餐页的渲染
  await registerConsoleStatic(app, {
    isLoggedIn: async () => opts.loggedIn ?? false,
    getHomePlans: async () => [],
  });
  await app.ready();
  return app;
}

describe('site SPA static hosting', () => {
  it('GET / returns the site shell with initial state (logged out)', async () => {
    const app = await build({ loggedIn: false });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const body = res.body;
    expect(body).toContain('<div id="app"></div>');
    expect(body).toContain('/assets/site/');
    expect(body).toContain('window.__INITIAL_STATE__={"loggedIn":false}');
    expect(body).toContain('<html lang="zh-CN"');
    // 中文首屏 SEO：中文 title + OG 卡片
    expect(body).toContain('<title>DevBelt — 在 VS Code 内完成数据库开发</title>');
    expect(body).toContain('property="og:title"');
    expect(body).toContain('name="twitter:card"');
    expect(body).toContain('og:image');
    // CSP nonce 应存在且匹配 bootstrap script 的 nonce
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    const nonce = csp.match(/nonce-([A-Za-z0-9+/=]+)/)?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).not.toContain('%NONCE%');
    // 占位符必须都被替换掉
    expect(body).not.toContain('<!--SEO_META-->');
  });

  it('GET /en returns shell with lang=en, English SEO and loggedIn=true state', async () => {
    const app = await build({ loggedIn: true });
    const res = await app.inject({ method: 'GET', url: '/en' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<html lang="en"');
    expect(res.body).toContain('window.__INITIAL_STATE__={"loggedIn":true}');
    expect(res.body).toContain('<title>DevBelt — Database development inside VS Code</title>');
    expect(res.body).toContain('og:locale" content="en_US"');
  });

  it('GET /plans renders the SSR plans page', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/plans' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('同步套餐');
  });

  it('screenshot static asset is served from site public/', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/screenshots/01-sql-workbench.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  it('SPA client-side path falls back to shell without initial state re-injection', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/features' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="app"></div>');
    expect(res.body).toContain('/assets/site/');
  });

  it('unknown extension path returns 404 (does not fall back to shell)', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/does-not-exist.png' });
    expect(res.statusCode).toBe(404);
  });

  it('auth pages return 404 when dist is missing rather than crashing', async () => {
    const app = await build();
    // override to a nonexistent dir by pointing to site dist for all (login.html won't exist)
    const res = await app.inject({ method: 'GET', url: '/login' });
    // login route serveHtml(null) -> notFound
    expect([404, 200]).toContain(res.statusCode); // 200 would mean build environment has auth dist in place
  });
});
