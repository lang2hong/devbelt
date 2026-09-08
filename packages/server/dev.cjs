/**
 * 开发运行器：与生产一致地跑 esbuild 打包产物，改动 TS 即重编译 + 重启。
 *
 * 之前 dev 用 `tsx watch`（ESM 直跑源码），与生产（CJS bundle）存在形态差异：
 * passwordWorker 的路径在两种形态下不同，容易本地测不出、上生产才炸。
 * 统一到 bundle 后，本地 = 生产，同一份 dist/。
 *
 * 行为：esbuild context.watch 监听 src/ 变化重建 dist/；每次重建完成后
 * （onEnd）杀死旧 `node dist/index.js`、重启新进程。SIGINT/SIGTERM 一并清理。
 */
const { context } = require('esbuild');
const { spawn } = require('child_process');
const { esbuildOptions } = require('./build.cjs');

let child = null;
let stopping = false;

function restart() {
  if (child) child.kill('SIGTERM');
  const id = (child = spawn('node', ['dist/index.cjs'], {
    stdio: 'inherit',
    // 本地裸跑开发循环：默认声明 development profile，使 cookie / Origin 的 dev 例外
    // 生效；显式导出 NODE_ENV（production 等）仍然优先，部署不受影响。
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'development' },
  }));
  id.on('exit', (code) => {
    if (!stopping && code !== 0) console.error(`[dev] server exited with code ${code}`);
  });
}

async function main() {
  const ctx = await context({
    ...esbuildOptions,
    logLevel: 'silent',
    plugins: [
      ...(esbuildOptions.plugins || []),
      {
        name: 'dev-restart',
        setup(b) {
          b.onEnd(() => {
            console.log('[dev] rebuilt — restarting server');
            restart();
          });
        },
      },
    ],
  });
  // watch 会先做一次初始构建并触发 onEnd（= 首次 start）
  await ctx.watch();
  console.log('[dev] watching src/ for changes...');

  const shutdown = () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
    void ctx.dispose().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});