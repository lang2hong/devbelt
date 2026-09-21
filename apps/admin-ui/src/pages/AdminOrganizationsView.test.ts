// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminOrganization } from '../api/admin';

vi.mock('../api/admin', () => ({
  listOrganizations: vi.fn(),
  adjustOrganizationSubscription: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listOrganizations, adjustOrganizationSubscription } from '../api/admin';
import AdminOrganizationsView from './AdminOrganizationsView.vue';

const org = (): AdminOrganization => ({
  organizationId: '1', name: 'Acme', status: 'active', planCode: 'organization_free', seatLimit: 3,
  activeMemberCount: 1, invitedCount: 0, subscriptionVersion: 1, periodEndTime: null,
  createTime: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.mocked(listOrganizations).mockReset();
  vi.mocked(listOrganizations).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
  vi.mocked(adjustOrganizationSubscription).mockReset();
});

describe('AdminOrganizationsView', () => {
  it('加载更多进行中重复点击不发起第二次请求', async () => {
    let resolveLoad!: (v: unknown) => void;
    const loadPromise = new Promise((r) => { resolveLoad = r; });
    let calls = 0;
    vi.mocked(listOrganizations).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ kind: 'ok', value: { items: [] as AdminOrganization[], nextCursor: 'c1' } });
      return loadPromise as never;
    });

    const wrapper = mount(AdminOrganizationsView);
    await flushPromises();

    const moreBtn = () => wrapper.findAll('button').find((b) => b.text().trim() === '加载更多')!;
    await moreBtn().trigger('click'); // paging 挂起
    await moreBtn().trigger('click'); // 被 paging 拦截
    await flushPromises();

    expect(listOrganizations).toHaveBeenCalledTimes(2);
    resolveLoad({ kind: 'ok', value: { items: [], nextCursor: null } });
    await flushPromises();
    wrapper.unmount();
  });

  it('空白原因不提交订阅调整', async () => {
    vi.mocked(listOrganizations).mockResolvedValue({ kind: 'ok', value: { items: [org()], nextCursor: null } });
    const wrapper = mount(AdminOrganizationsView, { attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '订阅')!.trigger('click');
    await flushPromises();

    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')!;
    confirmBtn.click();
    await flushPromises();

    expect(adjustOrganizationSubscription).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请填写操作原因');
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('非法席位（0/小数）不提交订阅调整', async () => {
    vi.mocked(listOrganizations).mockResolvedValue({ kind: 'ok', value: { items: [org()], nextCursor: null } });
    const wrapper = mount(AdminOrganizationsView, { attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '订阅')!.trigger('click');
    await flushPromises();

    const reasonInput = Array.from(document.querySelectorAll('input')).find((i) => i.getAttribute('placeholder') === '原因（必填）')!;
    (reasonInput as HTMLInputElement).value = '调整';
    reasonInput.dispatchEvent(new Event('input'));
    const seatInput = Array.from(document.querySelectorAll('input')).find((i) => i.getAttribute('placeholder') === '席位')!;
    (seatInput as HTMLInputElement).value = '0';
    seatInput.dispatchEvent(new Event('input'));

    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')!;
    confirmBtn.click();
    await flushPromises();

    expect(adjustOrganizationSubscription).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('席位必须为正整数');
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});