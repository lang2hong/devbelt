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
    priceCents: 9900,
    unit: 'month',
    highlights: ['支持的数据库：mysql / postgresql / sqlite', '设备数：不限'],
  },
];

describe('公开套餐页渲染', () => {
  it('渲染个人套餐，并格式化价格', () => {
    const html = renderPlansPage(PLANS);
    expect(html).toContain('Free');
    expect(html).toContain('Pro');
    expect(html).toContain('¥99');
    expect(html).toContain('支持的数据库：mysql / postgresql / sqlite');
  });

  it('套餐不可用时降级提示，不抛错', () => {
    expect(renderPlansPage(null)).toContain('套餐信息暂时不可用');
  });

  it('header 感知登录态，含首页/文档/套餐导航', () => {
    expect(renderPlansPage(PLANS)).toContain('href="/login"');
    expect(renderPlansPage(PLANS, { loggedIn: true })).toContain('href="/db/"');
    expect(renderPlansPage(PLANS, { loggedIn: true })).not.toContain('href="/login"');
    expect(renderPlansPage(PLANS)).toContain('href="/db/docs"');
    expect(renderPlansPage(PLANS)).toContain('href="/"');
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
    expect(html).not.toContain('onclick=');
  });
});
