import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Vite 开发/构建配置（P3-A）。
 *
 * - dev port 固定 5173，与 smtpEmailSender 的 SMTP_BASE_URL 默认值一致，
 *   注册验证邮件里的 /verify-email 链接在开发态直接落到本服务。
 * - /api 代理到 Fastify server（PORT 默认 3000），仅服务开发链路；
 *   生产静态托管由后续 P3 服务端 /console/* 承担，本片不扩展。
 */
export default defineConfig({
  plugins: [vue()],
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