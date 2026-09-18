import { describe, expect, it } from 'vitest';
import { renderHome, type HomePlan } from '../src/home.js';

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
  {
    code: 'organization_team',
    name: 'Organization Team',
    kind: 'organization',
    priceCents: 0,
    unit: 'seat-month',
    highlights: ['包含席位：10'],
  },
];

describe('套件首页渲染', () => {
  it('包含介绍/工具/套餐/入口四段', () => {
    const html = renderHome(PLANS);
    expect(html).toContain('开发者工具套件');
    expect(html).toContain('id="tools"');
    expect(html).toContain('id="pricing"');
    expect(html).toContain('id="entrances"');
    for (const tool of ['VS Code 数据库客户端', 'DB 控制台', '组织协作', '端到端加密同步', '平台后台']) {
      expect(html).toContain(tool);
    }
  });

  it('渲染个人与组织套餐，并格式化价格', () => {
    const html = renderHome(PLANS);
    expect(html).toContain('Free');
    expect(html).toContain('Pro');
    expect(html).toContain('Organization Team');
    expect(html).toContain('¥99');
    expect(html).toContain('待定价');
    expect(html).toContain('支持的数据库：mysql / postgresql / sqlite');
  });

  it('套餐不可用时降级提示，不抛错', () => {
    const html = renderHome(null);
    expect(html).toContain('套餐信息暂时不可用');
  });

  it('对套餐名做 HTML 转义（防注入）', () => {
    const html = renderHome([
      { code: 'x', name: '<script>alert(1)</script>', kind: 'personal', priceCents: 0, unit: 'month', highlights: [] },
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});