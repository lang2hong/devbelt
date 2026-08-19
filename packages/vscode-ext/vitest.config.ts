import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
  // 与 esbuild.js 的 define 对齐：测试不走 esbuild，需在这里提供同名字段
  define: {
    __SYNC_SERVER_URL__: JSON.stringify('http://localhost:3000'),
  },
});