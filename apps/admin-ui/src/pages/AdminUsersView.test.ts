// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminUser, AdminPlan } from '../api/admin';
import { toInclusiveEndIso } from '../lib/dateRange';

vi.mock('../api/admin', () => ({
  listUsers: vi.fn(),
  listPlans: vi.fn(),
  setUserStatus: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { listUsers, listPlans, setUserStatus } from '../api/admin';
import AdminUsersView from './AdminUsersView.vue';

const emptyPage = { kind: 'ok' as const, value: { items: [] as AdminUser[], nextCursor: null } };
const PLAN_FREE: AdminPlan = { id: 1, code: 'free', kind: 'personal', name: 'Free', priceCents: 0, billingUnit: 'month', sortOrder: 10, status: 'active', version: 1, features: {} };
const PLAN_PRO: AdminPlan = { id: 2, code: 'pro', kind: 'personal', name: 'Pro', priceCents: 800, billingUnit: 'month', sortOrder: 20, status: 'active', version: 1, features: {} };

beforeEach(() => {
  vi.mocked(listUsers).mockReset();
  vi.mocked(listUsers).mockResolvedValue(emptyPage);
  vi.mocked(listPlans).mockReset();
  vi.mocked(listPlans).mockResolvedValue({ kind: 'ok', value: { items: [PLAN_FREE, PLAN_PRO], featureDefs: [] } });
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

