import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttachmentStore,
  MAX_ATTACHMENTS,
  decodeImageBase64,
  sanitizeFileName,
  sniffImageMime,
} from '../../src/modules/feedback/service/attachmentStore';
import { FeedbackService } from '../../src/modules/feedback/service/feedbackService';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a----', 'ascii');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(4)]);
const BMP = Buffer.from([0x42, 0x4d, 0, 0]);

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'devbelt-fb-'));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function makeRepo() {
  return {
    create: vi.fn(async () => 7),
    createAttachments: vi.fn(async () => undefined),
    findAttachment: vi.fn(),
    deleteFeedback: vi.fn(async () => undefined),
    list: vi.fn(),
    updateStatusInTx: vi.fn(),
    overview: vi.fn(),
    findDetail: vi.fn(),
    listThread: vi.fn(async () => []),
    findForReplyInTx: vi.fn(),
    createReplyInTx: vi.fn(),
    markTriagedIfNewInTx: vi.fn(),
    updateReplyEmail: vi.fn(),
  };
}

const base = { userId: null as number | null, category: 'bug', content: 'x', installId: 'i', appVersion: '0.5.0', os: 'linux/x64' };

describe('图片类型识别与解码', () => {
  it('按文件头识别四种允许的图片', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
  });

  it('拒绝其它格式（含 SVG/BMP）', () => {
    expect(sniffImageMime(BMP)).toBeUndefined();
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });

  it('base64 必须是标准形式，不接受 data URL 前缀', () => {
    expect(decodeImageBase64(PNG.toString('base64'))).toEqual(PNG);
    expect(() => decodeImageBase64(`data:image/png;base64,${PNG.toString('base64')}`)).toThrow();
    expect(() => decodeImageBase64('')).toThrow();
  });

  it('文件名去掉路径与控制字符', () => {
    expect(sanitizeFileName('../../etc/passwd', 'x.png')).toBe('passwd');
    expect(sanitizeFileName('a\u0000b.png', 'x.png')).toBe('ab.png');
    expect(sanitizeFileName(undefined, 'x.png')).toBe('x.png');
  });
});

describe('AttachmentStore', () => {
  it('写入随机文件名（0600）、可读回、可删除', async () => {
    const dir = await tmpDir();
    const store = new AttachmentStore(dir);
    const name = await store.save(PNG, 'image/png');
    expect(name).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
    expect(await store.read(name)).toEqual(PNG);
    await store.remove([name]);
    await expect(readFile(path.join(dir, name))).rejects.toThrow();
  });

  it('拒绝非法的存储名（路径穿越）', async () => {
    const store = new AttachmentStore(await tmpDir());
    await expect(store.read('../secret')).rejects.toThrow(/invalid attachment storage name/);
  });
});

describe('FeedbackService 图片校验', () => {
  it('带图提交：写入文件与附件行', async () => {
    const repo = makeRepo();
    const store = new AttachmentStore(await tmpDir());
    const svc = new FeedbackService(repo as never, store);

    await expect(svc.submit({
      ...base,
      images: [{ fileName: 'shot.png', dataBase64: PNG.toString('base64') }],
    })).resolves.toEqual({ id: 7 });

    expect(repo.createAttachments).toHaveBeenCalledTimes(1);
    const [feedbackId, rows] = repo.createAttachments.mock.calls[0] as unknown as [number, Array<{ fileName: string; mime: string; sizeBytes: number }>];
    expect(feedbackId).toBe(7);
    expect(rows[0]).toMatchObject({ fileName: 'shot.png', mime: 'image/png', sizeBytes: PNG.length });
  });

  it('超过 3 张直接拒绝，不落库', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never, new AttachmentStore(await tmpDir()));
    const one = { fileName: 'a.png', dataBase64: PNG.toString('base64') };
    await expect(svc.submit({ ...base, images: Array.from({ length: MAX_ATTACHMENTS + 1 }, () => one) }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('非图片（BMP）被拒绝', async () => {
    const svc = new FeedbackService(makeRepo() as never, new AttachmentStore(await tmpDir()));
    await expect(svc.submit({ ...base, images: [{ fileName: 'x.bmp', dataBase64: BMP.toString('base64') }] }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('附件行写入失败：删除已写文件并补偿删除反馈', async () => {
    const dir = await tmpDir();
    const repo = makeRepo();
    repo.createAttachments.mockRejectedValueOnce(new Error('db down'));
    const svc = new FeedbackService(repo as never, new AttachmentStore(dir));

    await expect(svc.submit({ ...base, images: [{ fileName: 'a.png', dataBase64: PNG.toString('base64') }] }))
      .rejects.toThrow('db down');
    expect(repo.deleteFeedback).toHaveBeenCalledWith(7);
  });

  it('未配置存储时带图提交失败并补偿删除', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never);
    await expect(svc.submit({ ...base, images: [{ fileName: 'a.png', dataBase64: PNG.toString('base64') }] }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repo.deleteFeedback).toHaveBeenCalledWith(7);
  });
});
