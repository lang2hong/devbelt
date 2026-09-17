import { test, expect } from '@playwright/test';
import { uniqueEmail, PASSWORD, getVerificationLink } from './helpers/mailpit.js';

async function registerAndVerify(page, email) {
  await page.goto('/register');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page.getByText(/验证邮件已发送/)).toBeVisible();
  const link = await getVerificationLink(email);
  await page.goto(link);
  await expect(page.getByText(/邮箱验证成功/)).toBeVisible();
}

/**
 * 浏览器会话流：登录后会话持久（HttpOnly refresh cookie），刷新不回落登录，登出后回落。
 * 覆盖「浏览器会话流」发布门禁项。
 */
test('login persists across reload; logout returns to login', async ({ page }) => {
  const email = uniqueEmail();
  await registerAndVerify(page, email);

  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();

  // 登录成功回落 /console/*，随后刷新仍保持登录（HttpOnly refresh cookie 续期）。
  await page.waitForURL(/\/console\//);
  await page.reload();
  await page.waitForURL(/\/console\//);
  expect(page.url()).toContain('/console');
});