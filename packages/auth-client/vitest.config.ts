import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const dbHostSrc = fileURLToPath(new URL('../db-host/src', import.meta.url));

export default defineConfig({
  resolve: {
    // 测试直接跑 @devbelt/db-host 源码，避免依赖 dist 构建产物。
    alias: [
      { find: /^@devbelt\/db-host$/, replacement: `${dbHostSrc}/index.ts` },
      { find: /^@devbelt\/db-host\/(.*)$/, replacement: `${dbHostSrc}/$1` },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    server: { deps: { inline: [/packages\/db-host\//] } },
  },
});
