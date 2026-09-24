import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// runtime：auth-client 源码经子路径引用 `@devbelt/db-host/*`，这里直接指向 db-host 源码，
// 使 db-ui 构建不再依赖 db-host 的 dist（dist 仅用于 TS 解析，见 tsconfig）。
const dbHostSrc = fileURLToPath(new URL('../../packages/db-host/src', import.meta.url));

/**
 * Vite 开发/构建配置（P3）。
 *
 * 多入口：控制台 SPA（index.html，切片 3 用）+ 独立邮件入口（verify-email.html）。
 * 邮件页是独立 entry，不落 /console/* SPA fallback（§8/§3）。dev port 固定 5173，
 * /api 代理到 Fastify server（:3000）；生产静态托管由 server 的 consoleStatic.ts 承担。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^@devbelt\/db-host$/, replacement: `${dbHostSrc}/index.ts` },
      { find: /^@devbelt\/db-host\/(.*)$/, replacement: `${dbHostSrc}/$1` },
    ],
  },
  // 部署基路径：默认 `/db/`（与 server 的挂载点一致，避免裸 `pnpm build` 产出与其它应用
// 在 `/assets/` 冲突且 404）；可用 DEVBELT_DB_CONSOLE_BASE 覆盖。
  base: process.env.DEVBELT_DB_CONSOLE_BASE || '/db/',
  build: {
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
        'sync-reset': new URL('./sync-reset.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});