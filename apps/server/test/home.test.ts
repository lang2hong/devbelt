import { describe, expect, it } from 'vitest';
import { renderPlansPage, type HomePlan } from '../src/home.js';

const PLANS: HomePlan[] = [
  {
    code: 'free',
    name: 'Free',
    kind: 'personal',
    priceCents: 0,
    unit: 'month',
    highlights: ['支持的数据库：mysql / sqlite', '本机保存连接数：10'],
  },
  {
    code: 'pro',
    name: 'Pro',
    kind: 'personal',
    priceCents: 800,
    unit: 'month',
    highlights: ['支持的数据库：mysql / postgresql / sqlite', '设备数：不限'],
  },
];

describe('公开套餐页渲染', () => {
  it('渲染个人套餐，并格式化价格', () => {
    const html = renderPlansPage(PLANS);
    expect(html).toContain('Free');
    expect(html).toContain('Pro');
    expect(html).toContain('¥8');
    expect(html).toContain('支持的数据库：mysql / postgresql / sqlite');
  });

  it('套餐不可用时降级提示，不抛错', () => {
    expect(renderPlansPage(null)).toContain('套餐信息暂时不可用');
  });

  it('与文档/首页共用同一套导航与页脚', () => {
    const html = renderPlansPage(PLANS);
    // 导航顺序：安装 · 文档 · GitHub · 功能 · 套餐
    const navStart = html.indexOf('<nav>');
    const navEnd = html.indexOf('</nav>', navStart);
    const nav = html.slice(navStart, navEnd);
    let cursor = -1;
    for (const label of ['安装', '文档', 'GitHub', '功能', '套餐']) {
      const at = nav.indexOf(`>${label}<`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(nav).not.toContain('0.4.0');
    // 四列页脚
    expect(html).toContain('VS Code Marketplace');
    expect(html).toContain('Open VSX');
    expect(html).toContain('href="/en"');
  });

  it('套餐页高亮「套餐」，文档页高亮「文档」', () => {
    const plans = renderPlansPage(PLANS);
    expect(plans).toMatch(/<a href="\/plans" class="on">套餐<\/a>/);
    expect(plans).not.toMatch(/<a href="\/db\/docs" class="on">/);
  });

  it('header 感知登录态', () => {
    const headerOf = (html: string) => html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(headerOf(renderPlansPage(PLANS))).toContain('href="/login"');
    expect(headerOf(renderPlansPage(PLANS))).not.toContain('href="/db/">控制台');
    expect(headerOf(renderPlansPage(PLANS, { loggedIn: true }))).toContain('href="/db/">控制台');
    expect(headerOf(renderPlansPage(PLANS, { loggedIn: true }))).not.toContain('href="/login"');
  });

  it('对套餐名做 HTML 转义（防注入）', () => {
    const html = renderPlansPage([
      { code: 'x', name: '<script>alert(1)</script>', kind: 'personal', priceCents: 0, unit: 'month', highlights: [] },
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('不包含任何 inline script（严格 CSP 友好）', () => {
    const html = renderPlansPage(PLANS);
    expect(html).not.toContain('<script');
  });
});