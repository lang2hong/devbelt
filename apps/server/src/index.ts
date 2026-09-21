import 'dotenv/config';
import { createApp } from './app.js';

let server: Awaited<ReturnType<typeof createApp>> | undefined;

async function main(): Promise<void> {
  const app = await createApp();
  server = app;
  const port = Number(process.env.DEVBELT_DB_PORT || 3000);
  // 默认只绑回环：直接暴露到公网时，DEVBELT_DB_TRUST_PROXY 默认信任 1 跳会让客户端伪造的
  // X-Forwarded-For 被采信，按 IP 的限流与审计 sourceIp 全部失效。
  const host = process.env.DEVBELT_DB_HOST?.trim() || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const trustProxyExplicit = !!process.env.DEVBELT_DB_TRUST_PROXY && process.env.DEVBELT_DB_TRUST_PROXY.trim() !== '';
  if (!loopback && !trustProxyExplicit) {
    app.log.error(
      `Refusing to bind non-loopback host "${host}" without an explicit DEVBELT_DB_TRUST_PROXY. ` +
        'Set DEVBELT_DB_TRUST_PROXY=false when directly exposed, or DEVBELT_DB_TRUST_PROXY=1 when behind a trusted reverse proxy.',
    );
    process.exit(1);
  }
  try {
    await app.listen({ port, host });
    app.log.info(`DB Client server listening on ${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const signals = ['SIGTERM', 'SIGINT'] as const;
for (const sig of signals) {
  process.on(sig, async () => {
    if (server) {
      try { await server.close(); } catch {}
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
