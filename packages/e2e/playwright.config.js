import { defineConfig } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
// config 所在目录 = packages/e2e：webServer 命令相对此 cwd 起服务，
// 服务端 consoleStatic 也据此解析 ../console-ui/dist。
const e2eDir = dirname(fileURLToPath(import.meta.url));

/**
 * 浏览器 e2e（P3 切片 5 部署门禁自动化）：注册/登录/邮箱验证全链路。
 * server 已由 CI 构建（packages/server/dist + console-ui/dist），webServer 负责起服务并
 * 等 /health/live 就绪；MYSQL/密钥/MAILER 等 env 由 CI job 注入并被子进程继承。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: process.env.E2E_SERVER_CMD ?? 'node ../server/dist/index.cjs',
    cwd: e2eDir,
    url: `${BASE_URL}/health/live`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});