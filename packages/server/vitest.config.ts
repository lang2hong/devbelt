import { defineConfig } from 'vitest/config';

/**
 * 两个 project：单元测试并行，真库集成测试串行。
 *
 * integration 下的文件全都连**同一个** MySQL 测试库，并且各自调用
 * `initSchema`（并发 ALTER TABLE 加同一个索引）、做全表 DELETE（pruneEvents）、
 * 增删 users（外键级联）。也就是说它们共享可变状态 —— 并行跑时表现为
 * 随机失败：三轮里有一轮报「唯一键没建出来」或「该删的过期会话还在」，
 * 而单独跑每个文件都是绿的。
 *
 * 这类偶发不能靠重跑掩盖：它会在 CI 里变成时不时失败的流水线，久了就没人
 * 认真看红灯了。真库测试本来就该串行，代价只是多几秒。
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
          // 同一个库上的 DDL 与全表 DML 不能并发
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
