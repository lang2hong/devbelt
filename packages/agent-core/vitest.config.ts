import { defineConfig } from 'vitest/config';

/** Unit tests run in parallel; real-database tests run serially (shared test databases). */
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
