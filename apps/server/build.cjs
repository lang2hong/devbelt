/**
 * 服务端 esbuild 打包配置（被 build 与 dev 共用）。
 *
 * 目标：把 server 及其全部运行时依赖（fastify / @fastify/* / mysql2 / jose /
 * @noble/hashes / nodemailer / dotenv 等）打进**自包含**的 `dist/index.js`，
 * 生产部署无需在服务器上 `npm install`（deploy 推 dist + .env + 重启即可）。
 *
 * 为什么是 esbuild 而不是 tsc：tsc 只把 TS 编译成 JS，import 仍指向 node_modules；
 * esbuild 把依赖一起打进来，服务器零依赖。
 *
 * 为什么是 `format: 'cjs'`：这些依赖（dotenv 含 `require('fs')`、mysql2 含
 * `require('crypto')` 等）都是 CommonJS，打进 **esm** 输出会把内置模块的 require
 * 变成抛错的 `__require`（"Dynamic require of fs is not supported"）。Node 后端
 * 打成 cjs 是唯一稳妥格式，扩展端同样如此。因此 server 的 package.json **不设
 * `"type": "module"`**，让 dist 里的 .js 按 CommonJS 运行；源码 import 语法由
 * esbuild / vitest / tsc（typecheck 用）各自转译，互不影响。vitest 配置为
 * `.mts`（ESM），不受 type 字段影响。
 *
 * 多入口：`index`（主服务）与 `passwordWorker`（Argon2id worker 线程）。
 * passwordWorker 必须单独成文件——`password.ts` 运行时通过 `__dirname` / 进程
 * 工作目录定位同产物的 `passwordWorker.js` 来 `new Worker()`。
 */
const path = require('path');

const esbuildOptions = {
  entryPoints: {
    index: path.resolve(__dirname, 'src/index.ts'),
    passwordWorker: path.resolve(__dirname, 'src/modules/auth/service/passwordWorker.ts'),
    promoteAdmin: path.resolve(__dirname, 'src/scripts/promotePlatformAdmin.ts'),
  },
  bundle: true,
  outdir: path.resolve(__dirname, 'dist'),
  platform: 'node',
  format: 'cjs',
  // 输出 .cjs：无论部署机 package.json 是否残留 `"type": "module"`，都强制按
  // CommonJS 运行（此前服务器残留旧 package.json 的 type:module，导致 CJS bundle
  // 被当 ESM、require('fs') 抛错）。.cjs 扩展名使 type 字段完全失效。
  outExtension: { '.js': '.cjs' },
  target: 'node20',
  sourcemap: false,
  minify: false,
  // 依赖里 ESM 包（jose / @noble/hashes）与 CJS 包混用，module 优先解析。
  mainFields: ['module', 'main'],
  logLevel: 'info',
};

// 直接运行时做一次性生产构建；被 require（dev.cjs）时只导出配置。
if (require.main === module) {
  const { build } = require('esbuild');
  build(esbuildOptions).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { esbuildOptions };