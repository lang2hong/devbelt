import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMemento, FileSecureStorage } from '../src/ports.js';

describe('FileSecureStorage 持久化', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('并发 store 不丢更新（同文件读改写串行化）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'db-hostd-ports-'));
    const storage = new FileSecureStorage(join(dir, 'secrets.json'));
    await Promise.all(Array.from({ length: 20 }, (_, i) => storage.store(`k${i}`, `v${i}`)));
    for (let i = 0; i < 20; i++) {
      expect(await storage.get(`k${i}`)).toBe(`v${i}`);
    }
  });

  it('损坏的 secrets.json 抛错而不是静默覆盖丢失其余键', async () => {
    dir = await mkdtemp(join(tmpdir(), 'db-hostd-ports-'));
    const file = join(dir, 'secrets.json');
    await writeFile(file, '{not json');
    const storage = new FileSecureStorage(file);
    await expect(storage.store('k', 'v')).rejects.toThrow(/corrupt/);
    expect(await readFile(file, 'utf8')).toBe('{not json');
  });

  it('FileMemento.get 对损坏文件抛错（与写策略一致，不静默返回空）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'db-hostd-ports-'));
    const file = join(dir, 'memento.json');
    await writeFile(file, '{bad');
    const memento = new FileMemento(file);
    expect(() => memento.get('k')).toThrow();
  });
});