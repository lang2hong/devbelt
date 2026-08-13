import 'dotenv/config';
import { createApp } from './app.js';

/**
 * 同步服务入口。
 * createApp 完成插件注册 + schema 初始化 + 路由装配（组合根 DI）。
 */
async function main(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT || 3000);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Sync server listening on :${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
