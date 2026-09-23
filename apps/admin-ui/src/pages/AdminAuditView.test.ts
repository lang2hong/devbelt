// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { AdminAuditEvent } from '../api/admin';

vi.mock('../api/admin', () => ({
  queryAudit: vi.fn(),
  exportAudit: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { queryAudit } from '../api/admin';
import AdminAuditView from './AdminAuditView.vue';

const emptyPage = { kind: 'ok' as const, value: { items: [] as AdminAuditEvent[], nextCursor: null } };

beforeEach(() => {
  vi.mocked(queryAudit).mockReset();
  vi.mocked(queryAudit).mockResolvedValue(emptyPage);
});

describe('AdminAuditView 检索竞态', () => {
  it('旧检索请求晚返回不覆盖新筛选结果', async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstPromise = new Promise((r) => { resolveFirst = r; });
    let calls = 0;
    vi.mocked(queryAudit).mockImplementation(() => {
      calls += 1;
      if (calls === 1) return firstPromise as never;
      return Promise.resolve({ kind: 'ok', value: { items: [] as AdminAuditEvent[], nextCursor: null } }) as never;
    });

    const wrapper = mount(AdminAuditView);
    await flushPromises(); // onMounted load #1 挂起

    await wrapper.findAll('button').find((b) => b.text().trim() === '查询')!.trigger('click');
    await flushPromises(); // load #2 resolve 空页

    resolveFirst({
      kind: 'ok',
      value: {
        items: [{
          eventId: '1', eventTime: '2026-01-01T00:00:00.000Z', actorUserId: null, actorRole: null,
          eventType: 'auth.login.success', targetType: null, targetId: null,
          sourceIp: null, requestId: null, result: 'success', failureCode: null, reason: null,
        }],
        nextCursor: null,
      },
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain('auth.login.success');
    wrapper.unmount();
  });
});