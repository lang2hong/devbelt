import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const dbHostSrc = fileURLToPath(new URL('../../packages/db-host/src', import.meta.url));

const shared = {
  resolve: {
    // 测试直接跑 @devbelt/db-host 源码：既让内部 vi.mock（如 undici）生效，
    // 也避免"测试测的是编译产物"。源码内 `./x.js` 由 Vite 解析回 `./x.ts`。
    alias: [
      { find: /^@devbelt\/db-host$/, replacement: `${dbHostSrc}/index.ts` },
      { find: /^@devbelt\/db-host\/(.*)$/, replacement: `${dbHostSrc}/$1` },
    ],
  },
  // 与 esbuild.js 的 define 对齐：测试不走 esbuild，需在这里提供同名字段。
  // 必须放在每个 project 里：test.projects 不继承根级的 resolve/define。
  define: {
    __SYNC_SERVER_URL__: JSON.stringify('http://localhost:3000'),
  },
};

const testShared = {
  environment: 'node' as const,
  server: {
    deps: {
      // db-host 源码在 Vite root（apps/vscode-ext）之外，默认会被外部化，
      // 导致其内部 vi.mock（如 undici）不被拦截；按路径强制内联。
      inline: [/packages\/db-host\//],
    },
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          ...testShared,
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/integration/**'],
          testTimeout: 30000,
        },
      },
      {
        ...shared,
        test: {
          ...testShared,
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});