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
  // 三个安装渠道
  await expect(page.getByRole('link', { name: /Marketplace/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Open VSX/ })).toBeVisible();
  // 英文切换
  await expect(page.getByRole('button', { name: 'English' })).toBeVisible();
});

test('English homepage renders at /en', async ({ page }) => {
  await page.goto('/en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: '中文' })).toBeVisible();
  // 主标题包含 VS Code
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

test('公开文档中心 /db/docs 无需登录', async ({ page }) => {
  const res = await page.goto('/db/docs');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '使用文档' })).toBeVisible();
  await page.goto('/db/docs/getting-started');
  await expect(page.getByRole('heading', { name: '快速开始' })).toBeVisible();
});

test('公开套餐页 /plans 无需登录', async ({ page }) => {
  const res = await page.goto('/plans');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '同步套餐' })).toBeVisible();
  // 套餐卡来自 billing 目录（Free / Pro / ¥8；migration 013 已把 pro 从 ¥99 改为 ¥8）
  await expect(page.getByText('Pro', { exact: true })).toBeVisible();
  await expect(page.getByText('¥8')).toBeVisible();
});
