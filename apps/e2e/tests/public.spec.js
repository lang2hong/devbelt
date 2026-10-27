import { test, expect } from '@playwright/test';

/**
 * 公共页面 e2e（无需登录，确定性）：
 *  - 官网首页（site SPA）渲染 hero/features/showcase/new/install
 *  - 英文页 /en 渲染并切换到 lang=en
 *  - /admin 未登录时落到登录页
 *  - /db/ 控制台壳与静态资源可达
 *  - /plans SSR 套餐页可达
 *  - /db/docs 文档中心
 */

test('官网首页：hero/features/showcase/new/install 五段，带安装入口', async ({ page }) => {
  await page.goto('/');
  // hero 主标题包含 VS Code
  await expect(page.locator('h1')).toContainText(/VS Code/);
  await expect(page.locator('section')).not.toHaveCount(0);
  // 三个安装渠道：header/footer 都有链接，用 first() 锁定首屏的那一个
  await expect(page.getByRole('link', { name: /Marketplace/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Open VSX/ }).first()).toBeVisible();
  // 英文切换：导航里的语言按钮
  await expect(page.getByRole('navigation').getByRole('button', { name: 'English' })).toBeVisible();
});

test('English homepage renders at /en', async ({ page }) => {
  await page.goto('/en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation').getByRole('button', { name: '中文' })).toBeVisible();
  await expect(page.locator('h1')).toContainText(/VS Code/);
});

test('平台后台未登录：/admin 落到登录页而非"页面不存在"', async ({ page }) => {
  await page.goto('/admin/');
  await page.waitForURL(/\/login(\?|$)/, { timeout: 30_000 });
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('DB 控制台壳可达', async ({ page }) => {
  const res = await page.goto('/db/');
  expect(res?.status()).toBe(200);
  await expect(page.locator('body')).not.toHaveText(/not found/i);
});

test('公开文档中心 /db/docs 无需登录，且与官网同一导航/页脚', async ({ page }) => {
  const res = await page.goto('/db/docs');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '使用文档' })).toBeVisible();
  // 与官网一致：完整导航 + 四列页脚
  await expect(page.locator('header.top')).toContainText('安装');
  await expect(page.locator('header.top')).toContainText('GitHub');
  await expect(page.locator('footer')).toContainText('VS Code Marketplace');
  // 分组齐全
  await expect(page.getByRole('heading', { name: 'SQL 与数据' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Redis 与 Elasticsearch' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 与监控' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '账户与同步' })).toBeVisible();
});

test('文档用真实截图（不是内联 SVG）', async ({ page }) => {
  await page.goto('/db/docs/getting-started');
  await expect(page.getByRole('heading', { name: '快速开始' })).toBeVisible();
  const img = page.locator('figure.shot img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /\/screenshots\/01-sql-workbench\.png$/);
  await expect(img).toBeVisible();
  await expect(page.locator('svg.fig')).toHaveCount(0);
});

test('0.4.0 新增文档可访问：Redis / Elasticsearch / AI / 数据监控', async ({ page }) => {
  for (const [slug, heading] of [
    ['redis', 'Redis'],
    ['elasticsearch', 'Elasticsearch'],
    ['ai', 'AI 助手'],
    ['monitoring', '数据监控'],
    ['insight', '查询洞察'],
  ]) {
    const res = await page.goto(`/db/docs/${slug}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
  }
  // 监控文档带两张截图
  await page.goto('/db/docs/monitoring');
  await expect(page.locator('figure.shot img')).toHaveCount(2);
});

test('公开套餐页 /plans 无需登录', async ({ page }) => {
  const res = await page.goto('/plans');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '同步套餐' })).toBeVisible();
  // 套餐卡来自 billing 目录（Free / Pro / ¥8；migration 013 已把 pro 从 ¥99 改为 ¥8）
  await expect(page.getByText('Pro', { exact: true })).toBeVisible();
  await expect(page.getByText('¥8')).toBeVisible();
});
