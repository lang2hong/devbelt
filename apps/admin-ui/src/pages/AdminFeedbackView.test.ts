// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminFeedback, AdminFeedbackDetail } from '../api/admin';

vi.mock('../api/admin', () => ({
  queryFeedback: vi.fn(),
  getFeedbackDetail: vi.fn(),
  replyFeedback: vi.fn(),
  setFeedbackStatus: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { queryFeedback, getFeedbackDetail } from '../api/admin';
import AdminFeedbackView from './AdminFeedbackView.vue';

function fb(id: string, status: AdminFeedback['status']): AdminFeedback {
  return {
    id,
    userId: null,
    userEmail: null,
    installId: `inst-${id}`,
    hasReplyKey: true,
    category: 'bug',
    content: `content-${id}`,
    contact: 'user@example.test',
    appVersion: '0.4.1',
    os: 'linux/x64',
    status,
    adminNote: null,
    sourceIp: '203.0.113.9',
    createTime: '2026-10-28T00:00:00.000Z',
    updateTime: '2026-10-28T00:00:00.000Z',
  };
}

function detailOf(f: AdminFeedback): AdminFeedbackDetail {
  return { feedback: f, userEmail: null, inAppDeliverable: true, replies: [], attachments: [] };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(queryFeedback).mockReset();
  vi.mocked(getFeedbackDetail).mockReset();
  vi.mocked(getFeedbackDetail).mockImplementation(async (id: string) => ({
    kind: 'ok',
    value: detailOf(fb(id, 'new')),
  }));
});

describe('AdminFeedbackView 用户列邮箱', () => {
  it('有账号邮箱时显示，匿名反馈不显示', async () => {
    const withEmail = { ...fb('7', 'new'), userId: '9', userEmail: 'owner@example.test' };
    const anonymous = fb('6', 'new');
    vi.mocked(queryFeedback).mockResolvedValue({ kind: 'ok', value: { items: [withEmail, anonymous], nextCursor: null, total: 2 } });

    const wrapper = mount(AdminFeedbackView);
    await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.findAll('td')[3]!.text()).toContain('owner@example.test');
    expect(rows[1]!.findAll('td')[3]!.text()).not.toContain('@');
    expect(wrapper.text()).toContain('用户 / 邮箱');
    wrapper.unmount();
  });
});

describe('AdminFeedbackView 操作列', () => {
  it('未结案（待处理 / 处理中）显示“回复”，已结案显示“查看”', async () => {
    const items = [fb('3', 'new'), fb('2', 'triaged'), fb('1', 'done'), fb('0', 'rejected')];
    vi.mocked(queryFeedback).mockResolvedValue({ kind: 'ok', value: { items, nextCursor: null, total: 4 } });

    const wrapper = mount(AdminFeedbackView);
    await flushPromises();

    const reply = wrapper.findAll('[data-testid="feedback-reply"]');
    const view = wrapper.findAll('[data-testid="feedback-view"]');
    expect(reply).toHaveLength(2);
    expect(reply.every((b) => b.text() === '回复')).toBe(true);
    expect(view).toHaveLength(2);
    expect(view.every((b) => b.text() === '查看')).toBe(true);
    wrapper.unmount();
  });

  it('状态标签：triaged 显示“处理中”，不再出现“已分类”', async () => {
    const items = [fb('2', 'triaged')];
    vi.mocked(queryFeedback).mockResolvedValue({ kind: 'ok', value: { items, nextCursor: null, total: 1 } });

    const wrapper = mount(AdminFeedbackView);
    await flushPromises();
    expect(wrapper.text()).toContain('处理中');
    expect(wrapper.text()).not.toContain('已分类');
    wrapper.unmount();
  });

  it('点“回复”打开宽弹窗并聚焦回复框；点“查看”不抢焦点', async () => {
    const items = [fb('3', 'new'), fb('2', 'done')];
    vi.mocked(queryFeedback).mockResolvedValue({ kind: 'ok', value: { items, nextCursor: null, total: 2 } });

    const wrapper = mount(AdminFeedbackView, { attachTo: document.body });
    await flushPromises();

    await wrapper.find('[data-testid="feedback-reply"]').trigger('click');
    await flushPromises();
    expect(document.querySelector('.modal.modal-lg')).not.toBeNull();
    expect(getFeedbackDetail).toHaveBeenCalledWith('3');
    expect(document.activeElement?.id).toBe('reply-body');

    // 关闭后用“查看”打开：同样是宽弹窗，但焦点留在对话框本身。
    (document.querySelector('.modal-mask') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('.modal')).toBeNull();

    await wrapper.find('[data-testid="feedback-view"]').trigger('click');
    await flushPromises();
    expect(document.querySelector('.modal.modal-lg')).not.toBeNull();
    expect(document.activeElement?.id).not.toBe('reply-body');
    wrapper.unmount();
  });
});
