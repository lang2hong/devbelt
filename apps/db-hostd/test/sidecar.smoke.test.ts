import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const distEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'db-hostd-smoke-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('db-hostd sidecar 进程冒烟', () => {
  it('拉起真实进程，写一行 JSON-RPC，读到一行响应', async () => {
    const child = spawn(process.execPath, [distEntry], {
      env: { ...process.env, DEVKIT_HOSTD_HOME: home },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    try {
      const line = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('sidecar timeout')), 10_000);
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const idx = buf.indexOf('\n');
          if (idx >= 0) {
            clearTimeout(timer);
            resolve(buf.slice(0, idx));
          }
        });
        child.on('error', reject);
        child.stdin.write(`${JSON.stringify({ id: 42, method: 'ping' })}\n`);
      });

      expect(JSON.parse(line)).toEqual({ id: 42, result: 'pong' });
    } finally {
      child.kill();
    }
  });
});