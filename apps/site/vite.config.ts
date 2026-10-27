import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * DevBelt 产品官网（站点根路径）。
 *
 * 单入口 SPA，由 vue-router 处理 `/`（中文）与 `/en`（英文）两个路径；
 * 生产由 Fastify server 通过 @fastify/static 托管 dist，在 consoleStatic.ts 中做 SPA fallback。
 * dev port 5176；`/api` 代理到 Fastify server（:3000）以方便开发时调 /plans 等接口。
 */
export default defineConfig({
  plugins: [vue()],
  base: process.env.DEVBELT_SITE_BASE || '/',
  build: {
    assetsDir: 'assets/site',
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 5176,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/plans': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/db/docs': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/login': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/register': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
