import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 身份页 SPA（挂站点根路径）。
 *
 * 多入口：登录、注册、验证邮箱各自独立 HTML，由 server 静态托管在
 * `/login`、`/register`、`/verify-email`。base 固定 `/`
 * （身份页在根）；dev port 5174，`/api` 代理到 Fastify server（:3000）。
 */
export default defineConfig({
  plugins: [vue()],
  base: process.env.DEVBELT_DB_AUTH_BASE || '/',
  build: {
    rollupOptions: {
      input: {
        login: new URL('./login.html', import.meta.url).pathname,
        register: new URL('./register.html', import.meta.url).pathname,
        'verify-email': new URL('./verify-email.html', import.meta.url).pathname,
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});