import { defineConfig } from 'vitest/config';

/**
 * 两个 project：单元测试并行，真库集成测试串行。
 *
 * integration 下的文件都连同一个 MySQL 测试库，各自 CREATE/DROP 临时表、
 * 起会话、执行 KILL QUERY 并查 information_schema.processlist ——
 * 后者尤其容易被并发干扰（另一个文件的 SLEEP 会被计进来）。
 * 与 server 包同样的取舍：真库测试串行，代价只是多几秒。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
