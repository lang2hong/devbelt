import { describe, expect, it } from 'vitest';
import { renderHome, renderPlansPage, type HomePlan } from '../src/home.js';

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

describe('套件首页渲染', () => {
  it('包含介绍/工具两段，且不再有套餐区块', () => {
    const html = renderHome();
    expect(html).toContain('欢迎使用 DevBelt');
    expect(html).toContain('id="intro"');
    expect(html).toContain('id="tools"');
    expect(html).not.toContain('id="pricing"');
    expect(html).not.toContain('开发者工具套件');
  });

  it('顶部 header 吸顶', () => {
    const html = renderHome();
    expect(html).toMatch(/header\.top\s*\{[^}]*position:\s*sticky/);
    expect(html).toMatch(/header\.top\s*\{[^}]*top:\s*0/);
  });

  it('介绍段列出能力卡片', () => {
    const html = renderHome();
    for (const t of ['本地数据库客户端', '端到端加密同步', 'Web 控制台']) {
      expect(html).toContain(t);
    }
  });

  it('工具段列出已发布扩展与待开发项，并带 Marketplace 链接', () => {
    const html = renderHome();
    for (const tool of ['DB Client', 'DevBelt DB Client', 'REST NEO', 'l2h-harness']) {
      expect(html).toContain(tool);
    }
    expect(html).toContain('https://marketplace.visualstudio.com/items?itemName=lang2hong.db-client');
    expect(html).toContain('https://marketplace.visualstudio.com/items?itemName=lang2hong.rest-client-neo');
    expect(html).toContain('待开发');
  });

  it('DevBelt DB Client 卡片链接到公开文档 /db/docs（站内，不新开标签）', () => {
    const html = renderHome();
    expect(html).toContain('href="/db/docs"');
    expect(html).not.toContain('href="/db/docs" target="_blank"');
    expect(html).toContain('文档');
  });

  it('套餐入口指向公开 /plans，且 header 不再用页内锚点', () => {
    expect(renderHome()).toContain('href="/plans"');
    expect(renderHome({ loggedIn: true })).toContain('href="/plans"');
    expect(renderHome()).not.toContain('href="#pricing"');
  });

  it('未登录：header 与 hero 显示登录/注册入口，且带文档入口', () => {
    const html = renderHome();
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/register"');
    expect(html).toContain('免费开始');
    expect(html).not.toContain('href="/db/"');
    expect(html).toContain('href="/db/docs"');
  });

  it('已登录：header 与 hero 改为控制台入口，不再显示登录/注册', () => {
    const html = renderHome({ loggedIn: true });
    expect(html).toContain('href="/db/"');
    expect(html).toContain('进入控制台');
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain('href="/register"');
    expect(html).not.toContain('免费开始');
  });
});

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

  it('header 感知登录态，并含首页/文档/套餐导航', () => {
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
});