import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeChunksToFile } from '../../src/utils/writeChunks';

function tempFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-chunks-'));
  return { dir, file: path.join(dir, 'out.txt') };
}

describe('writeChunksToFile', () => {
  it('成功：文件内容完整', async () => {
    const { dir, file } = tempFile();
    try {
      await writeChunksToFile(file, async (write) => { await write('a'); await write('b'); });
      expect(fs.readFileSync(file, 'utf8')).toBe('ab');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('producer 中途抛错：删除半截文件后冒泡原始错误', async () => {
    const { dir, file } = tempFile();
    try {
      await expect(
        writeChunksToFile(file, async (write) => { await write('partial'); throw new Error('boom'); }),
      ).rejects.toThrow('boom');
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});