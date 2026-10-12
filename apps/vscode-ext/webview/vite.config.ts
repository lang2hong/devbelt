import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

/**
 * Vite 配置：构建 Vue 3 webview UI。
 *
 * 输出到 ../out/webview/，供 VSCode 扩展通过 webview.asWebviewUri() 加载。
 * base: './' 确保 webview 内资源路径为相对路径。
 */
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: resolve(__dirname, '../out/webview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      // 双入口：index（共享 App.vue mode switch）+ aiChat（P9 AI 面板独立入口）。
      input: {
        index: resolve(__dirname, 'src/main.ts'),
        aiChat: resolve(__dirname, 'src/ai-main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name][extname]',
        chunkFileNames: 'chunks/[name].js',
      },
    },
  },
});
