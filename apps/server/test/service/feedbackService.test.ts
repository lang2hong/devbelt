import { describe, expect, it, vi } from 'vitest';
import { FeedbackService, MAX_FEEDBACK_CONTENT } from '../../src/modules/feedback/service/feedbackService';

function makeRepo() {
  return {
    create: vi.fn(async () => 42),
    list: vi.fn(),
    updateStatusInTx: vi.fn(),
    overview: vi.fn(),
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
});