import { describe, expect, it, vi } from 'vitest';
import { FeedbackService, MAX_FEEDBACK_CONTENT, hashReplyKey } from '../../src/modules/feedback/service/feedbackService';

const REPLY_KEY = 'B'.repeat(43);

function makeRepo() {
  return {
    create: vi.fn(async () => 42),
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

const base = {
  userId: null,
  category: 'bug',
  content: '表格列宽在窄窗口下会溢出',
  installId: 'abc',
  appVersion: '0.4.1',
  os: 'linux/x64',
  sourceIp: '127.0.0.1',
};

describe('FeedbackService', () => {
  it('提交时裁剪空白并落库', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never);
    await expect(svc.submit({ ...base, content: '  hello  ', contact: '  a@b.c  ' })).resolves.toEqual({ id: 42 });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      category: 'bug',
      content: 'hello',
      contact: 'a@b.c',
      userId: null,
    }));
  });

  it('拒绝未知分类', async () => {
    const svc = new FeedbackService(makeRepo() as never);
    await expect(svc.submit({ ...base, category: 'spam' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('拒绝空内容与超长内容', async () => {
    const svc = new FeedbackService(makeRepo() as never);
    await expect(svc.submit({ ...base, content: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(svc.submit({ ...base, content: 'x'.repeat(MAX_FEEDBACK_CONTENT + 1) }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('联系方式与安装 ID 超长时拒绝', async () => {
    const svc = new FeedbackService(makeRepo() as never);
    await expect(svc.submit({ ...base, contact: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(svc.submit({ ...base, installId: 'x'.repeat(65) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('replyKey 只以 SHA-256 落库', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never);
    await svc.submit({ ...base, replyKey: REPLY_KEY });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ replyKeyHash: hashReplyKey(REPLY_KEY) }));
    expect(hashReplyKey(REPLY_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('拒绝非法 replyKey 与缺 installId 的 replyKey', async () => {
    const svc = new FeedbackService(makeRepo() as never);
    await expect(svc.submit({ ...base, replyKey: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(svc.submit({ ...base, installId: undefined, replyKey: REPLY_KEY }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('FeedbackService.thread', () => {
  it('匿名凭证 + 账号合并查询', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never);
    await svc.thread({ installId: 'abc', replyKey: REPLY_KEY, userId: 9 });
    expect(repo.listThread).toHaveBeenCalledWith({
      anonymous: { installId: 'abc', replyKeyHash: hashReplyKey(REPLY_KEY) },
      userId: 9,
      limit: 50,
    });
  });

  it('只有账号时不带匿名条件', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never);
    await svc.thread({ userId: 9 });
    expect(repo.listThread).toHaveBeenCalledWith({ userId: 9, limit: 50 });
  });

  it('无凭证或 replyKey 非法时直接返回空', async () => {
    const repo = makeRepo();
    const svc = new FeedbackService(repo as never);
    await expect(svc.thread({ installId: 'abc', userId: null })).resolves.toEqual([]);
    await expect(svc.thread({ installId: 'abc', replyKey: 'bad', userId: null })).resolves.toEqual([]);
    expect(repo.listThread).not.toHaveBeenCalled();
  });
});