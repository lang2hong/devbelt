/**
 * 平台管理员显式提权 CLI。
 *
 * 用法：
 *   pnpm -C apps/server admin:promote -- --email admin@example.com
 *
 * 与启动期引导同一套门禁：只有「邮箱已验证 + 账号 active」的账号才会被提升；
 * 不满足则打印原因并以非零码退出（fail-closed）。用于远端已注册但暂不便重启服务的场景。
 */
import 'dotenv/config';
import { createAdminDeps } from '../bootstrap/mysqlDeps.js';
import { promotePlatformAdmin } from '../service/platformAdminBootstrap.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('--email');
  if (!email) {
    console.error('usage: admin:promote -- --email <address>');
    process.exit(2);
  }

  const deps = createAdminDeps(process.env);
  try {
    const result = await promotePlatformAdmin(
      deps.userRepo,
      deps.auditWriter,
      email,
      (msg, data) => console.warn(msg, data),
    );

    console.log(JSON.stringify(result));
    if (result.kind !== 'granted' && result.kind !== 'already-admin') {
      process.exitCode = 1;
    }
  } finally {
    await deps.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});