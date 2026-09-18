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
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

// 构建时读取环境文件，注入为全局常量（define）。
// 开发（--watch / F5 调试）读 .env，生产打包读 .env.production；
// 唯一消费方是 src/sync/authService.ts（DEFAULT_SERVER_URL）；
// 测试不走 esbuild，同名字段由 vitest.config.ts 的 define 提供。
function loadDotEnv() {
  const file = path.resolve(__dirname, isWatch ? '.env' : '.env.production');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[m[1]] = val;
  }
  return env;
}
const env = loadDotEnv();

// ssh2 的可选原生加速 .node（sshcrypto.node）：esbuild 无法 bundle，"No loader for .node"。
// 用插件把它们标为 external，留给运行时按需 require —— 缺失时 ssh2 内部 try/catch 降级纯 JS
// （与 external: ['cpu-features'] 同一意图）。JS API 的 external 只收字符串，正则需走插件。
const nativeNodeExternal = {
  name: 'native-node-external',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
  },
};

const options = {
  // 多入口：extension 是主扩展；argon2Worker 是独立 worker 线程入口（Argon2id 须在 Worker 执行）。
  entryPoints: {
    extension: path.resolve(__dirname, 'src/extension.ts'),
    argon2Worker: path.resolve(__dirname, '../../packages/db-host/src/sync/crypto/argon2Worker.ts'),
    mainThreadFixture: path.resolve(__dirname, '../../packages/db-host/src/sync/crypto/mainThreadFixture.ts'),
  },
  bundle: true,
  outdir: path.resolve(__dirname, 'out'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: 'inline',
  minify: false,
  // external: vscode 由扩展 host 提供；cpu-features 为 ssh2 的可选原生加速
  // （缺失时 ssh2 内部 try/catch 自动降级），ssh2 本身打包进 bundle 使 VSIX 自包含
  external: ['vscode', 'cpu-features'],
  plugins: [nativeNodeExternal],
  // db-core 是 ESM 源码，经由 workspace 链接解析，需声明为可打包依赖
  mainFields: ['module', 'main'],
  logLevel: 'info',
  define: {
    __SYNC_SERVER_URL__: JSON.stringify(env.SYNC_SERVER_URL || (isWatch ? 'http://localhost:3000' : 'https://devkit.l2hi.com')),
    // pg@8 加载时用 `typeof navigator` 检测 Cloudflare Workers；VS Code 1.101+ 的
    // extension host 会拦截 navigator 访问并在开发模式打印 PendingMigrationError 日志。
    // 本项目源码不使用 navigator，打包期替换为 undefined 让 pg 走 node 分支，消除噪音。
    navigator: 'undefined',
  },
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