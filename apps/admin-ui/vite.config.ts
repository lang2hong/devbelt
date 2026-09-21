import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 平台后台 SPA，挂 `/admin/`（base 由 DEVBELT_DB_ADMIN_BASE 注入，默认 `/admin/`）。
 * dev port 5175，`/api` 代理到 Fastify server（:3000）。
 */
export default defineConfig({
  plugins: [vue()],
  base: process.env.DEVBELT_DB_ADMIN_BASE || '/admin/',
  server: {
    port: 5175,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
