// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminUser } from '../api/admin';

vi.mock('../api/admin', () => ({
  listUsers: vi.fn(),
  setUserStatus: vi.fn(),
  setUserRole: vi.fn(),
  adjustUserSubscription: vi.fn(),
  getAdminAiQuota: vi.fn(),
  getSyncOverview: vi.fn(),
  listSyncRecords: vi.fn(),
  listAdminOrders: vi.fn(),
  listAdminInvoices: vi.fn(),
  queryAudit: vi.fn(),
  listAdminUserAiRequests: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import {
  listUsers, getAdminAiQuota, getSyncOverview, listSyncRecords,
  listAdminOrders, listAdminInvoices, queryAudit, listAdminUserAiRequests,
} from '../api/admin';
import AdminUserDetailView from './AdminUserDetailView.vue';

const USER: AdminUser = {
  userId: '7', email: 'u@b.com', emailVerified: true, displayName: null, status: 'active',
  role: 'user', lastLoginTime: '2026-10-10T08:00:00Z', planCode: 'free', deviceCount: 1,
  subscriptionVersion: null, periodEndTime: null, createTime: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listUsers).mockReset();
  vi.mocked(getAdminAiQuota).mockReset();
  vi.mocked(getSyncOverview).mockReset();
  vi.mocked(listSyncRecords).mockReset();
  vi.mocked(listAdminOrders).mockReset();
  vi.mocked(listAdminInvoices).mockReset();
  vi.mocked(queryAudit).mockReset();
  vi.mocked(listAdminUserAiRequests).mockReset();
  vi.mocked(listAdminUserAiRequests).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
  vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [USER], nextCursor: null } });
  vi.mocked(getSyncOverview).mockResolvedValue({ kind: 'ok', value: [] });
  vi.mocked(listSyncRecords).mockResolvedValue({
    kind: 'ok',
    value: { state: null, items: [], nextCursor: null },
  });
});

async function mountDetail() {
  const wrapper = mount(AdminUserDetailView, { props: { userId: '7' }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

async function switchTab(label: string): Promise<void> {
  const btn = Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === label);
  (btn as HTMLElement).click();
  await flushPromises();
}

describe('AdminUserDetailView', () => {
  it('概览：渲染用户档案（状态/角色徽标、套餐、注册时间）', async () => {
    const wrapper = await mountDetail();
    const text = wrapper.text();
    expect(text).toContain('u@b.com');
    expect(text).toContain('启用');
    expect(text).toContain('普通用户');
    expect(text).toContain('用户 ID');
    expect(text).toContain('2026-01-01 08:00:00');
  });

  it('AI 积分页签：指标卡/充值聚合/近月用量/充值余额 + 请求记录', async () => {
    vi.mocked(listAdminUserAiRequests).mockResolvedValue({
      kind: 'ok',
      value: {
        items: [{
          requestId: 'req-1', model: 'qwen-plus', usageMonth: '2026-10', status: 'completed',
          rawPromptTokens: 2000, rawCompletionTokens: 500,
          billingPromptTokens: 2000, billingCompletionTokens: 2000,
          costCents: 3, usageEstimated: false, latencyMs: 1200, createTime: '2026-10-15T10:00:00Z',
        }],
        nextCursor: null,
      },
    });
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
    await mountDetail();
    await switchTab('AI 积分');
    expect(getAdminAiQuota).toHaveBeenCalledWith(7);
    expect(listAdminUserAiRequests).toHaveBeenCalledWith('7', {});
    const text = document.body.textContent ?? '';
    expect(text).toContain('1.2'); // 本月已用 1,200 计费 token = 1.2 积分
    expect(text).toContain('3 笔');
    expect(text).toContain('¥38.00');
    expect(text).toContain('2026-10');
    expect(text).toContain('topup_500k');
    expect(text).toContain('请求记录');
    expect(text).toContain('qwen-plus');
    expect(text).toContain('2,000');
    expect(text).toContain('4');
    expect(text).toContain('1.2s');
  });

  it('订单页签：按用户过滤查询，渲染订单行', async () => {
    vi.mocked(listAdminOrders).mockResolvedValue({
      kind: 'ok',
      value: {
        items: [{
          orderNo: 'ord-1', userId: '7', userEmail: 'u@b.com', userDisplayName: null,
          purpose: 'topup', planCode: null, skuCode: 'topup_500k', amountCents: 3800,
          channel: 'wechat', status: 'fulfilled', channelTradeNo: 'wx-1',
          paidTime: null, expiresTime: '2026-10-01T00:00:00Z', createTime: '2026-09-28T10:00:00Z', updateTime: '2026-09-28T10:05:00Z',
        }],
        nextCursor: null,
      },
    });
    await mountDetail();
    await switchTab('订单');
    expect(listAdminOrders).toHaveBeenCalledWith({ userId: '7', cursor: undefined });
    const text = document.body.textContent ?? '';
    expect(text).toContain('ord-1');
    expect(text).toContain('积分充值');
    expect(text).toContain('已生效');
    expect(text).toContain('¥38.00');
  });

  it('同步数据页签：状态卡 + 类型汇总 + 记录明细 + 隐私说明', async () => {
    vi.mocked(getSyncOverview).mockResolvedValue({
      kind: 'ok',
      value: [{ entityKind: 'SavedConnection', count: 12, bytes: 4096, lastActivityTime: '2026-10-12T00:00:00Z' }],
    });
    vi.mocked(listSyncRecords).mockResolvedValue({
      kind: 'ok',
      value: {
        state: { keyEpoch: '1', stateVersion: '5', changeSequence: '128', protocolVersion: 2, cipherSuite: 'aes-256-gcm', formatVersion: 1 },
        items: [{
          recordId: '05060708deadbeef', entityKind: 'SavedConnection', version: '2', changeSequence: '11',
          bytes: 88, createTime: '2026-09-01T00:00:00Z', updateTime: '2026-10-12T00:00:00Z',
        }],
        nextCursor: null,
      },
    });
    await mountDetail();
    await switchTab('同步数据');
    expect(listSyncRecords).toHaveBeenCalledWith('7', { kind: undefined });
    const text = document.body.textContent ?? '';
    expect(text).toContain('12 条');
    expect(text).toContain('aes-256-gcm');
    expect(text).toContain('05060708deadbeef'.slice(0, 16) + '…');
    expect(text).toContain('端到端加密');
  });

  it('同步明细 kind 过滤重新查询', async () => {
    const state = { keyEpoch: '1', stateVersion: '5', changeSequence: '128', protocolVersion: 2, cipherSuite: 'aes-256-gcm', formatVersion: 1 };
    vi.mocked(getSyncOverview).mockResolvedValue({
      kind: 'ok',
      value: [{ entityKind: 'SavedConnection', count: 2, bytes: 128, lastActivityTime: null }],
    });
    vi.mocked(listSyncRecords).mockResolvedValue({
      kind: 'ok',
      value: { state, items: [], nextCursor: null },
    });
    await mountDetail();
    await switchTab('同步数据');
    const select = document.querySelector('.bar select') as HTMLSelectElement;
    select.value = 'SavedConnection';
    select.dispatchEvent(new Event('change'));
    await flushPromises();
    expect(listSyncRecords).toHaveBeenLastCalledWith('7', { kind: 'SavedConnection' });
  });

  it('操作记录页签：按操作者过滤，事件类型显示中文', async () => {
    vi.mocked(queryAudit).mockResolvedValue({
      kind: 'ok',
      value: {
        items: [{
          eventId: 'e1', eventTime: '2026-10-12T00:00:00Z', actorUserId: '7', actorRole: 'user',
          eventType: 'ai.chat.completed', targetType: null, targetId: null,
          sourceIp: null, requestId: null, result: 'success', failureCode: null, reason: null,
        }],
        nextCursor: null,
      },
    });
    await mountDetail();
    await switchTab('操作记录');
    expect(queryAudit).toHaveBeenCalledWith({ actorUserId: '7', cursor: undefined });
    const text = document.body.textContent ?? '';
    expect(text).toContain('成功');
  });

  it('用户不存在：显示提示与返回链接', async () => {
    vi.mocked(listUsers).mockResolvedValue({ kind: 'ok', value: { items: [], nextCursor: null } });
    const wrapper = await mountDetail();
    expect(wrapper.text()).toContain('用户不存在');
    expect(wrapper.text()).toContain('返回列表');
  });
});
