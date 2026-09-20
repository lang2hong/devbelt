import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecureStorageLike, ThenableLike } from '@devkit/db-host';
import type { MementoLike } from '@devkit/db-host/sync/e2e/stateStore';

/**
 * 宿主端口（ports）的**文件实现**：让 db-host 在没有 VS Code 的进程里也能运行。
 *
 * 仅用于 sidecar / CLI 场景；安全性弱于 VS Code SecretStorage（明文文件 + 0600 权限）。
 * 真正的桌面宿主应注入各自的安全存储实现。
 */

type JsonRecord = Record<string, unknown>;

function parseRecord(raw: string): JsonRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonRecord;
  throw new Error('record is not a JSON object');
}

function readRecordSync(file: string): JsonRecord {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  // 与异步 readRecord 一致：文件存在但损坏 → 抛错，而不是静默当成空对象。
  return parseRecord(raw);
}

/**
 * 读取并严格解析记录文件。
 *
 * 文件不存在 → 空对象；存在但内容损坏 → **抛错**。过去损坏也返回 `{}`，随后 store
 * 会把损坏文件覆盖成只含新键的内容，静默丢失其余数据。
 */
async function readRecord(file: string): Promise<JsonRecord> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    return parseRecord(raw);
  } catch (err) {
    throw new Error(`corrupt JSON record in ${file}: ${(err as Error).message}`);
  }
}

/** 同文件的读改写串行化，避免并发 store/update 相互覆盖（丢更新）。 */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(file, run.then(() => undefined, () => undefined));
  return run;
}

async function writeRecordAtomic(file: string, value: JsonRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  // 唯一临时名：并发写同一文件时不会互相踩坏对方的 tmp 内容。
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => { /* 清理尽力而为 */ });
    throw err;
  }
}

/** `SecureStorageLike` 的文件实现（明文 + 0600）。 */
export class FileSecureStorage implements SecureStorageLike {
  constructor(private readonly file: string) {}

  async get(key: string): Promise<string | undefined> {
    return withFileLock(this.file, async () => {
      const all = await readRecord(this.file);
      const v = all[key];
      return typeof v === 'string' ? v : undefined;
    });
  }

  async store(key: string, value: string): Promise<void> {
    return withFileLock(this.file, async () => {
      const all = await readRecord(this.file);
      all[key] = value;
      await writeRecordAtomic(this.file, all);
    });
  }

  async delete(key: string): Promise<void> {
    return withFileLock(this.file, async () => {
      const all = await readRecord(this.file);
      delete all[key];
      await writeRecordAtomic(this.file, all);
    });
  }
}

/** `MementoLike` 的文件实现。 */
export class FileMemento implements MementoLike {
  constructor(private readonly file: string) {}

  get<T>(key: string): T | undefined {
    return readRecordSync(this.file)[key] as T | undefined;
  }

  update(key: string, value: unknown): ThenableLike<void> {
    return this.persist(key, value) as unknown as ThenableLike<void>;
  }

  private async persist(key: string, value: unknown): Promise<void> {
    return withFileLock(this.file, async () => {
      const all = await readRecord(this.file);
      all[key] = value;
      await writeRecordAtomic(this.file, all);
    });
  }
}