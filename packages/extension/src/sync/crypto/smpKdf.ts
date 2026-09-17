import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { assertSmpKdfParams, type SmpKdfParams } from './smpKdfParams';
import { decodeBase64Url } from './recoveryCode';

/**
 * 主线程侧 Argon2id KDF 门面（任务 4/5）。
 *
 * 通过 `worker_threads` 把 KEK_smp 派生交给 `argon2Worker.js`，主线程绝不执行 Argon2id。
 * Worker 未就绪（路径不存在/构造失败）→ fail-closed 抛「Argon2id Worker unavailable」，
 * 拒绝解锁，不 fallback 到主线程、不排队。每次派生新建 worker、不池化（单条请求）。
 */

export interface WorkerLike {
  postMessage(value: unknown): void;
  once(event: string, cb: (arg: unknown) => void): void;
  terminate(): unknown;
}

export interface SmpKdfWorkerDeps {
  spawnWorker?: () => WorkerLike;
  /** 单请求超时（ms），默认 30s（Argon2id 最差 cost 下也足够）。 */
  timeoutMs?: number;
}

interface WorkerResponse {
  ok: boolean;
  result?: string;
  error?: string;
}

const KEK_BYTES = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

/** 生产 bundle：与 argon2Worker.js 同处 out/；测试/开发：回退到包根 out/。 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'argon2Worker.js'),
    resolve(process.cwd(), 'out', 'argon2Worker.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function defaultSpawn(): WorkerLike {
  return new Worker(resolveWorkerPath()) as unknown as WorkerLike;
}

export async function deriveKekSmpInWorker(smp: string, params: SmpKdfParams, deps?: SmpKdfWorkerDeps): Promise<Uint8Array> {
  assertSmpKdfParams(params);

  let worker: WorkerLike;
  try {
    worker = deps?.spawnWorker ? deps.spawnWorker() : defaultSpawn();
  } catch (err) {
    throw new Error(`Argon2id Worker unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        void worker.terminate();
      } catch {
        // 忽略终止失败（worker 可能已退出）
      }
      fn();
    };

    timer = setTimeout(() => settle(() => rejectPromise(new Error('Argon2id Worker timed out'))), timeoutMs);

    worker.once('message', (raw) => {
      // 每个 worker 只对应一条请求：任意首条 message 即响应；形状非法 → fail-closed。
      const msg = raw as WorkerResponse;
      if (typeof msg !== 'object' || msg === null || typeof msg.ok !== 'boolean') {
        settle(() => rejectPromise(new Error('Argon2id Worker returned invalid response')));
        return;
      }
      if (!msg.ok) {
        settle(() => rejectPromise(new Error(msg.error || 'Argon2id Worker failed')));
        return;
      }
      let kek: Uint8Array;
      try {
        kek = decodeBase64Url(msg.result ?? '');
      } catch {
        settle(() => rejectPromise(new Error('Argon2id Worker returned corrupt KEK')));
        return;
      }
      if (kek.length !== KEK_BYTES) {
        settle(() => rejectPromise(new Error('Argon2id Worker returned wrong KEK length')));
        return;
      }
      settle(() => resolvePromise(kek));
    });
    worker.once('error', (raw) => {
      const e = raw as Error;
      settle(() => rejectPromise(new Error(`Argon2id Worker error: ${e.message}`)));
    });
    worker.once('exit', () => {
      // 未收到响应就退出（含 code 0）同样视为失败，不空等到 timeout。
      if (!settled) settle(() => rejectPromise(new Error('Argon2id Worker exited before response')));
    });

    try {
      worker.postMessage({ smp, params });
    } catch (err) {
      settle(() => rejectPromise(new Error(`Argon2id Worker postMessage failed: ${err instanceof Error ? err.message : String(err)}`)));
    }
  });
}