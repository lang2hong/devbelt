import { test, expect } from '@playwright/test';

/**
 * 公共页面 e2e（无需登录，确定性）：
 *  - 套件首页四段与套餐（服务端渲染）
 *  - /admin 未登录时落到登录页（不再是「页面不存在」）
 *  - /db/ 控制台壳与静态资源可达
 * 这三处是本阶段改过的 Web 面，放进 CI 防止回归。
 */

test('套件首页：介绍/工具/套餐三段与实时套餐', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '开发者工具套件' })).toBeVisible();
  await expect(page.locator('#tools')).toBeVisible();
  await expect(page.locator('#pricing')).toBeVisible();
  // 已发布/开发中工具
  await expect(page.getByText('DB Client', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('REST NEO')).toBeVisible();
  await expect(page.getByText('DevBelt DB Client')).toBeVisible();
  // 套餐卡来自 billing 目录（Free / Pro / ¥99）
  await expect(page.getByText('Pro', { exact: true })).toBeVisible();
  await expect(page.getByText('¥99')).toBeVisible();
});

test('平台后台未登录：/admin 落到登录页而非“页面不存在”', async ({ page }) => {
  await page.goto('/admin/');
  // admin-ui 客户端在未登录时 window.location.assign('/login?returnTo=/admin...')
  await page.waitForURL(/\/login(\?|$)/, { timeout: 30_000 });
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('DB 控制台壳可达', async ({ page }) => {
  const res = await page.goto('/db/');
  expect(res?.status()).toBe(200);
  await expect(page.locator('body')).not.toHaveText(/not found/i);
});

test('公开文档中心 /docs 无需登录', async ({ page }) => {
  const res = await page.goto('/docs');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '使用文档' })).toBeVisible();
  // 文档卡片可进入单篇
  await page.goto('/docs/getting-started');
  await expect(page.getByRole('heading', { name: '快速开始' })).toBeVisible();
});

test('公开套餐页 /plans 无需登录', async ({ page }) => {
  const res = await page.goto('/plans');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '套餐' })).toBeVisible();
});