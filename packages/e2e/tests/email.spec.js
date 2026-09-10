import { test, expect } from '@playwright/test';
import { uniqueEmail, PASSWORD, getVerificationLink } from './helpers/mailpit.js';

/**
 * 邮件链路 e2e：注册 → 管理端真发验证邮件（Mailpit）→ 浏览器打开邮件链接完成验证。
 * 覆盖「邮件链路 e2e」发布门禁项（真实 SMTP sink + 一次性链接落点）。
 */
test('register → verify via emailed link', async ({ page }) => {
  const email = uniqueEmail();

  await page.goto('/register');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page.getByText(/验证邮件已发送/)).toBeVisible();

  const link = await getVerificationLink(email);
  await page.goto(link);
  await expect(page.getByText(/邮箱验证成功/)).toBeVisible();
});