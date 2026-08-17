import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { fileURLToPath } from 'node:url';

/**
 * 构建 admin 管理后台，产物输出到 packages/server/public，
 * 由 server 通过 @fastify/static 以 /admin/ 前缀托管。
 * base '/admin/' 保证资源绝对路径与托管前缀一致。
 */
const dir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [vue()],
  base: '/admin/',
  build: {
    outDir: resolve(dir, '../server/public'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/admin/users': 'http://localhost:3000',
      '/admin/plans': 'http://localhost:3000',
      '/admin/subscriptions': 'http://localhost:3000',
    },
  },
});