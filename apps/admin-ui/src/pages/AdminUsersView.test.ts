// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminUser } from '../api/admin';
import { toInclusiveEndIso } from '../lib/dateRange';

vi.mock('../api/admin', () => ({
  listUsers: vi.fn(),
  setUserStatus: vi.fn(),
  adjustUserSubscription: vi.fn(),
  getSyncOverview: vi.fn(),
  setUserRole: vi.fn(),
  getAdminAiQuota: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { getAdminAiQuota, listUsers, setUserStatus } from '../api/admin';
import AdminUsersView from './AdminUsersView.vue';

const emptyPage = { kind: 'ok' as const, value: { items: [] as AdminUser[], nextCursor: null } };

beforeEach(() => {
  vi.mocked(listUsers).mockReset();
  vi.mocked(listUsers).mockResolvedValue(emptyPage);
  vi.mocked(setUserStatus).mockReset();
});

function searchButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').find((b) => b.text().trim() === '搜索')!;
}

describe('AdminUsersView 筛选', () => {
  it('非数字用户 ID 不发起请求并提示', async () => {
    const wrapper = mount(AdminUsersView);
    await flushPromises();
    expect(listUsers).toHaveBeenCalledTimes(1);

    await wrapper.find('input[placeholder="用户ID"]').setValue('abc');
    await searchButton(wrapper).trigger('click');
    await flushPromises();

    expect(listUsers).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('用户 ID 必须为正整数');
    wrapper.unmount();
  });

  it('createdTo 分钟精度值归一为所选分钟末尾后上送', async () => {
    const wrapper = mount(AdminUsersView);
    await flushPromises();

    const dateInputs = wrapper.findAll('input[type="datetime-local"]');
    await dateInputs[1].setValue('2026-09-13T10:30');
    await searchButton(wrapper).trigger('click');
    await flushPromises();

    const calls = vi.mocked(listUsers).mock.calls;
    const lastFilters = calls[calls.length - 1][0];
    expect(lastFilters?.createdTo).toBe(toInclusiveEndIso('2026-09-13T10:30'));
    wrapper.unmount();
  });

  it.each(['0', '-1', '9007199254740993'])('非法用户 ID "%s" 不发请求并提示', async (raw) => {
    const wrapper = mount(AdminUsersView);
    await flushPromises();
    expect(listUsers).toHaveBeenCalledTimes(1);

    await wrapper.find('input[placeholder="用户ID"]').setValue(raw);
    await searchButton(wrapper).trigger('click');
    await flushPromises();

    expect(listUsers).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('用户 ID 必须为正整数');
    wrapper.unmount();
  });

  it('禁用用户时空白原因不提交', async () => {
    const user: AdminUser = {
      userId: '1', email: 'a@b.com', emailVerified: true, displayName: null, status: 'active', role: 'member',
      lastLoginTime: null, planCode: null, deviceCount: 0, subscriptionVersion: null, periodEndTime: null,
      createTime: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [user], nextCursor: null } });

    const wrapper = mount(AdminUsersView, { attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '禁用')!.trigger('click');
    await flushPromises();

    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认')!;
    confirmBtn.click();
    await flushPromises();

    expect(setUserStatus).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('请填写操作原因');
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});

describe('AdminUsersView · AI 用量弹层', () => {
  const USER: AdminUser = {
    userId: '7', email: 'u@b.com', emailVerified: true, displayName: null, status: 'active',
    role: 'user', lastLoginTime: null, planCode: 'free', deviceCount: 1,
    subscriptionVersion: null, periodEndTime: null, createTime: '2026-01-01T00:00:00Z',
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.mocked(getAdminAiQuota).mockReset();
  });

  it('点击「AI 用量」：渲染配额/购买聚合/近月用量/加油包余额', async () => {
    vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [USER], nextCursor: null } });
    vi.mocked(getAdminAiQuota).mockResolvedValue({
      kind: 'ok',
      value: {
        snapshot: { used: 1200, reserved: 50, monthlyRemaining: 98800, topupRemaining: 3800, remaining: 102600, resetAt: '2026-11-01T00:00:00Z' },
        grants: [{ grantId: 1, orderId: 7, skuCode: 'topup_500k', status: 'active', tokensTotal: 5000, tokensUsed: 1200, tokensReserved: 0, expiresTime: '2027-10-01T00:00:00Z' }],
        months: [
          { usageMonth: '2026-10', promptTokens: 1000, completionTokens: 200, requestCount: 12 },
          { usageMonth: '2026-09', promptTokens: 300, completionTokens: 100, requestCount: 4 },
        ],
        topupOrders: { totalCount: 3, paidCount: 2, paidCents: 3800, refundedCount: 1, lastPaidTime: '2026-10-10T00:00:00Z' },
      },
    });
    const wrapper = mount(AdminUsersView);
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().trim() === 'AI 用量')!.trigger('click');
    await flushPromises();
    expect(getAdminAiQuota).toHaveBeenCalledWith(7);
    const text = document.body.textContent ?? '';
    expect(text).toContain('已用 1,200');
    expect(text).toContain('3 笔');
    expect(text).toContain('¥38.00');
    expect(text).toContain('2026-10');
    expect(text).toContain('topup_500k');
  });

  it('无数据：各区块显示空态', async () => {
    vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [USER], nextCursor: null } });
    vi.mocked(getAdminAiQuota).mockResolvedValue({
      kind: 'ok',
      value: {
        snapshot: { used: 0, reserved: 0, monthlyRemaining: 0, topupRemaining: 0, remaining: 0, resetAt: null },
        grants: [],
      },
    });
    const wrapper = mount(AdminUsersView);
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().trim() === 'AI 用量')!.trigger('click');
    await flushPromises();
    const text = document.body.textContent ?? '';
    expect(text).toContain('0 笔');
    expect(text).toContain('无用量记录。');
  });
});

