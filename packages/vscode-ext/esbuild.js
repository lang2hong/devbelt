/**
 * esbuild 打包配置。
 *
 * 目标：把 db-core、mysql2、pg 等依赖打进单个扩展 bundle，
 * 运行时仅 external 掉 `vscode`（由 VSCode host 提供）。
 *
 * 模式：
 *  - `npm run build`    一次性生产打包
 *  - `npm run dev`      监听文件变化自动重编译（供 F5 调试）
 */
const { build, context } = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.resolve(__dirname, 'src/extension.ts')],
  bundle: true,
  outfile: path.resolve(__dirname, 'out/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: 'inline',
  minify: false,
  // external: vscode 由扩展 host 提供；ssh2 含可选原生模块，运行时加载
  external: ['vscode', 'ssh2', 'cpu-features'],
  // db-core 是 ESM 源码，经由 workspace 链接解析，需声明为可打包依赖
  mainFields: ['module', 'main'],
  logLevel: 'info',
};

async function run() {
  if (isWatch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await build(options);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});