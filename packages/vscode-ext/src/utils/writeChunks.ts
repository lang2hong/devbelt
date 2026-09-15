import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { once } from 'events';

/**
 * 把生产者分块写入本地文件（含背压与错误冒泡）。
 *
 * 供大文件导出/备份使用：不再把整份内容拼成字符串/Buffer 再一次性写盘。
 * 扩展宿主在本地与 Remote 下都用 Node fs，`fsPath` 均指向对应文件系统。
 */
export async function writeChunksToFile(
  fsPath: string,
  producer: (write: (chunk: string | Uint8Array) => Promise<void>) => Promise<void>,
): Promise<void> {
  await mkdir(dirname(fsPath), { recursive: true });
  const stream = createWriteStream(fsPath);
  const streamError = new Promise<never>((_, reject) => stream.once('error', reject));
  try {
    await Promise.race([
      producer(async (chunk) => {
        if (!stream.write(chunk)) await once(stream, 'drain');
      }),
      streamError,
    ]);
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.once('error', reject);
    });
  } catch (err) {
    stream.destroy();
    throw err;
  }
}