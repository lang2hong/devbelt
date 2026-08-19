import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * 安全响应头。
 *
 * 管理后台是 server 同源托管的 SPA，admin token 存在 localStorage 里 ——
 * 这个组合下 CSP 不是「加分项」而是最后一道防线：任何一处 XSS（后台要渲染
 * 用户邮箱、设备名、连接名这些用户可控字符串）都能直接读走 token，
 * 而 token 是 admin 的。`script-src 'self'` 挡住注入的 inline script 与
 * 外部脚本，也就挡住了绝大多数把 token 外发出去的路径。
 *
 * 另外三个头各自对应一类具体攻击，不是形式主义：
 *  - nosniff：/admin/* 托管静态文件，MIME 猜测能把上传/回显的文本当脚本执行
 *  - frame-ancestors / X-Frame-Options：后台被嵌进 iframe 做点击劫持
 *  - X-Powered-By：默认回显 Fastify 版本，等于告诉扫描器该试哪些已知漏洞
 */
let t: TestApp;
beforeEach(async () => { t = await buildTestApp(); });
afterEach(async () => { await t.close(); });

/** 后台页面与 API 都要带头 —— 攻击面在两边都存在。 */
const PATHS = ['/health', '/api/me'];

describe('安全响应头', () => {
  it('每个响应都带 CSP，且 script-src 不含 unsafe-inline', async () => {
    for (const url of PATHS) {
      const res = await t.app.inject({ method: 'GET', url });
      const csp = res.headers['content-security-policy'];
      expect(csp, `${url} 缺少 CSP`).toBeTruthy();
      const text = String(csp);
      expect(text).toContain("default-src 'self'");
      expect(text).toMatch(/script-src[^;]*'self'/);
      // 有 unsafe-inline 的 script-src 等于没有 CSP：注入的 <script> 照样执行
      const scriptSrc = /script-src([^;]*)/.exec(text)?.[1] ?? '';
      expect(scriptSrc, 'script-src 不能允许 unsafe-inline').not.toContain('unsafe-inline');
      expect(scriptSrc, 'script-src 不能允许 unsafe-eval').not.toContain('unsafe-eval');
    }
  });

  /**
   * Vue 的 v-show 生成 `style="display:none"` 内联属性，CSP3 里由 style-src
   * 兜住（没有单独的 style-src-attr 时）。不允许 unsafe-inline 会让后台的
   * 标签切换直接坏掉 —— 这是一个有意识的妥协，写成断言以免日后被「顺手收紧」。
   */
  it('style-src 允许 inline（v-show 依赖 style 属性）', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(/style-src([^;]*)/.exec(csp)?.[1] ?? '').toContain("'unsafe-inline'");
  });

  it('CSP 禁止被嵌入 iframe，且不留 object/embed 通道', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('带 nosniff 与 X-Frame-Options', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['x-frame-options']).toUpperCase()).toBe('DENY');
  });

  it('不回显 X-Powered-By', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  /**
   * Referrer-Policy：后台 URL 里带用户 id，默认策略会把它带到外链去。
   */
  it('带 Referrer-Policy', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['referrer-policy']).toBeTruthy();
  });

  /**
   * HSTS 只能由部署层（nginx）决定：应用侧不知道自己是否真的在 HTTPS 后面，
   * 在纯 HTTP 部署上发 HSTS 会把用户浏览器锁死在一个访问不了的 https 地址上。
   */
  it('不擅自发 HSTS（是否 HTTPS 由反代决定）', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('401 这类错误响应同样带安全头', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/plans' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
