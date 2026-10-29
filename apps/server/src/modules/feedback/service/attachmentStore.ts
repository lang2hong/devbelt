import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '../../../domain/errors.js';
import type { FeedbackAttachmentMime } from '../../../repository/interfaces/feedback.js';

/** 单张图片上限 2 MiB；单条反馈最多 3 张、总计 6 MiB。 */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 6 * 1024 * 1024;

const EXT: Readonly<Record<FeedbackAttachmentMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const STORAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

/**
 * 按文件头识别图片类型。**不信任客户端声明的 mime**：只接受这四种，
 * SVG 明确拒绝（可内嵌脚本，不能当图片直接回显）。
 */
export function sniffImageMime(buf: Buffer): FeedbackAttachmentMime | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

/** 严格 base64 解码：拒绝空白/URL-safe/带 data URL 前缀的输入。 */
export function decodeImageBase64(dataBase64: string): Buffer {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) throw new ValidationError('image data is empty');
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    throw new ValidationError('image data is not valid base64');
  }
  return Buffer.from(dataBase64, 'base64');
}

/** 去掉路径、控制字符与过长的文件名；只用于展示，不参与磁盘路径。 */
export function sanitizeFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * 反馈图片的磁盘存储。
 *
 * 文件名随机、扩展名由**嗅探出的类型**决定；目录 0700、文件 0600。
 * 不做公开静态托管，读取只经管理后台的鉴权路由。
 */
export class AttachmentStore {
  constructor(readonly root: string) {}

  async save(data: Buffer, mime: FeedbackAttachmentMime): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.${EXT[mime]}`;
    await writeFile(path.join(this.root, name), data, { mode: 0o600, flag: 'wx' });
    return name;
  }

  async read(storageName: string): Promise<Buffer> {
    if (!STORAGE_NAME.test(storageName)) throw new Error('invalid attachment storage name');
    return readFile(path.join(this.root, storageName));
  }

  /** 补偿删除：文件不存在视为成功。 */
  async remove(names: readonly string[]): Promise<void> {
    for (const name of names) {
      if (!STORAGE_NAME.test(name)) continue;
      try {
        await unlink(path.join(this.root, name));
      } catch { /* 已被删除或从未写入 */ }
    }
  }
}
