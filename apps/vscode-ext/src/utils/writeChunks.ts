import { createWriteStream, rmSync } from 'fs';
import { chmod, mkdir } from 'fs/promises';
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
  // 导出内容可能含业务数据：与连接/验证器/备份导出同口径，默认 0600。
  // mode 只对新建文件生效，覆盖已存在的宽松权限文件时由下方 chmod 收紧。
  const stream = createWriteStream(fsPath, { mode: 0o600 });
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
    await chmod(fsPath, 0o600).catch(() => { /* Windows/文件系统不支持时忽略 */ });
  } catch (err) {
    stream.destroy();
    // 取消/失败不留半截文件：删掉已写出的部分（best-effort，不吞原始错误）。
    try { rmSync(fsPath, { force: true }); } catch { /* 忽略清理失败 */ }
    throw err;
  }
}