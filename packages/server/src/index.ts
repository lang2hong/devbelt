import 'dotenv/config';
import { createApp } from './app.js';

let server: Awaited<ReturnType<typeof createApp>> | undefined;

async function main(): Promise<void> {
  const app = await createApp();
  server = app;
  const port = Number(process.env.PORT || 3000);
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Sync server listening on :${port}`);
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
