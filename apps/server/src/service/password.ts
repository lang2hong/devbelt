import { randomBytes, timingSafeEqual } from 'crypto';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { existsSync } from 'fs';
import type { Argon2Request, Argon2Response } from './passwordWorker.js';

/**
 * 密码哈希（Argon2id，纯 JS @noble/hashes），**在 worker 线程中计算**。
 *
 * 参数固定（实施规格 §5.1）：memory 65536 KiB、iterations 3、parallelism 1、
 * salt 16 bytes、output 32 bytes。每个 hash 自描述算法与参数，格式：
 *
 *   `argon2id$m=65536,t=3,p=1$<salt base64>$<hash base64>`
 *
 * 验证时按**存储的自描述参数**重算（而非当前硬编码参数），使未来参数升级后
 * 旧 hash 仍可验证。
 *
 * 为什么必须异步：单次计算实测约 2.4s。放在主线程会阻塞整个事件循环
 * （/health、其它请求、清理定时器全部停摆），而 `argon2idAsync` 实测并不让出
 * 事件循环，所以只能移到 worker。详见 passwordWorker.ts。
 */

const HASH_PREFIX = 'argon2id$';
const SALT_BYTES = 16;

/** 固定参数（写入自描述串；验证以存储串为准）。 */
const MEMORY_KIB = 65536;
const ITERATIONS = 3;
const PARALLELISM = 1;
const OUTPUT_BYTES = 32;

/**
 * 验证时允许的参数上界。存储串里的 m/t/p 会被直接喂给 argon2，
 * 若数据库被篡改成极大值，一次验证即可耗尽内存。故设硬上限，超限视为无效 hash。
 */
const MAX_MEMORY_KIB = 1024 * 1024; // 1 GiB
const MAX_ITERATIONS = 16;
const MAX_PARALLELISM = 16;

/**
 * worker 脚本路径。打包（build.cjs CJS）下 `__dirname` 指向 dist/；tsx/vitest 下
 * `__dirname` 可能缺失或指向源码目录（没有 passwordWorker.js 实体）。故按候选路径
 * 逐个做存在性检查，命中打包产物（dist/passwordWorker.js）即用；都不存在则报错，
 * 提示先 `pnpm build`（测试脚本已改为先构建再跑）。
 */
function workerUrl(): URL {
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, 'passwordWorker.cjs'));
  }
  candidates.push(join(process.cwd(), 'dist', 'passwordWorker.cjs'));
  for (const c of candidates) {
    if (existsSync(c)) return pathToFileURL(c);
  }
  throw new Error('passwordWorker.cjs not found; run `pnpm build` first');
}

/** 派发一次 Argon2id 计算到新建 worker，算完即退。 */
function computeHash(
  password: string,
  salt: Uint8Array,
  memoryKib: number,
  iterations: number,
  parallelism: number,
  outputBytes: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(workerUrl());
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      // terminate 的结果不影响本次计算，忽略其错误。
      void worker.terminate().catch(() => {});
      fn();
    };

    worker.once('message', (resp: Argon2Response) => {
      if (resp.ok) finish(() => resolve(Buffer.from(resp.hash)));
      else finish(() => reject(new Error(`argon2 worker failed: ${resp.error}`)));
    });
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => {
      // 正常路径下 message 先到并置 settled；此处只兜住「未回消息就退出」。
      if (!settled) finish(() => reject(new Error(`argon2 worker exited early (code ${code})`)));
    });

    const req: Argon2Request = {
      password,
      salt,
      m: memoryKib,
      t: iterations,
      p: parallelism,
      dkLen: outputBytes,
    };
    worker.postMessage(req);
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await computeHash(password, salt, MEMORY_KIB, ITERATIONS, PARALLELISM, OUTPUT_BYTES);
  return `${HASH_PREFIX}m=${MEMORY_KIB},t=${ITERATIONS},p=${PARALLELISM}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * 校验密码。使用 timingSafeEqual 防时序攻击；旧格式/坏参数一律返回 false。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(HASH_PREFIX)) return false;
  const body = stored.slice(HASH_PREFIX.length);
  const sep1 = body.indexOf('$');
  if (sep1 < 0) return false;
  const params = body.slice(0, sep1);
  const rest = body.slice(sep1 + 1);
  const sep2 = rest.lastIndexOf('$');
  if (sep2 < 0) return false;
  const salt = Buffer.from(rest.slice(0, sep2), 'base64');
  const expected = Buffer.from(rest.slice(sep2 + 1), 'base64');

  const pm = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(params);
  if (!pm) return false;
  const m = Number(pm[1]);
  const t = Number(pm[2]);
  const p = Number(pm[3]);
  if (!Number.isInteger(m) || !Number.isInteger(t) || !Number.isInteger(p) || m <= 0 || t <= 0 || p <= 0) {
    return false;
  }
  // 上界防护：被篡改的存储串不得据以分配任意内存。
  if (m > MAX_MEMORY_KIB || t > MAX_ITERATIONS || p > MAX_PARALLELISM) return false;
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await computeHash(password, salt, m, t, p, expected.length);
  } catch {
    // worker 失败按校验失败处理，不放行。
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
