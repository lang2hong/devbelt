import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  return {};
}

function readRecordSync(file: string): JsonRecord {
  try {
    return parseRecord(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function readRecord(file: string): Promise<JsonRecord> {
  try {
    return parseRecord(await readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeRecordAtomic(file: string, value: JsonRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, file);
}

/** `SecureStorageLike` 的文件实现（明文 + 0600）。 */
export class FileSecureStorage implements SecureStorageLike {
  constructor(private readonly file: string) {}

  async get(key: string): Promise<string | undefined> {
    const all = await readRecord(this.file);
    const v = all[key];
    return typeof v === 'string' ? v : undefined;
  }

  async store(key: string, value: string): Promise<void> {
    const all = await readRecord(this.file);
    all[key] = value;
    await writeRecordAtomic(this.file, all);
  }

  async delete(key: string): Promise<void> {
    const all = await readRecord(this.file);
    delete all[key];
    await writeRecordAtomic(this.file, all);
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
    const all = await readRecord(this.file);
    all[key] = value;
    await writeRecordAtomic(this.file, all);
  }
}