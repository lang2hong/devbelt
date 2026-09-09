import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Vite 开发/构建配置（P3）。
 *
 * 多入口：控制台 SPA（index.html，切片 3 用）+ 独立邮件入口（verify-email.html）。
 * 邮件页是独立 entry，不落 /console/* SPA fallback（§8/§3）。dev port 固定 5173，
 * /api 代理到 Fastify server（:3000）；生产静态托管由 server 的 consoleStatic.ts 承担。
 */
export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
        'verify-email': new URL('./verify-email.html', import.meta.url).pathname,
        'accept-invitation': new URL('./accept-invitation.html', import.meta.url).pathname,
        login: new URL('./login.html', import.meta.url).pathname,
        register: new URL('./register.html', import.meta.url).pathname,
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