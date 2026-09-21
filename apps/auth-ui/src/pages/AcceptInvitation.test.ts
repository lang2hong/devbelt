// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  claimLinkFlow: vi.fn(),
  acceptInvitation: vi.fn(),
  bindMailFlow: vi.fn(),
  ensureCsrf: vi.fn(async () => 'csrf'),
  refresh: vi.fn(async () => ({ kind: 'ok' })),
  getAccessToken: vi.fn(() => 'at'),
}));

import { claimLinkFlow, acceptInvitation, bindMailFlow } from '@devbelt/auth-client';
import { refresh } from '@devbelt/auth-client';

function setLocation(path: string): void {
  window.history.replaceState(null, '', path);
}

beforeEach(() => {
  vi.mocked(claimLinkFlow).mockReset();
  vi.mocked(acceptInvitation).mockReset();
  vi.mocked(bindMailFlow).mockReset();
  vi.mocked(refresh).mockReset();
});

describe('AcceptInvitation state machine', () => {
  it('retains the in-memory token across claim network failure and retries to success', async () => {
    setLocation('/accept-invitation?token=TOK123');

    vi.mocked(claimLinkFlow).mockResolvedValueOnce({ kind: 'failure' }).mockResolvedValue({ kind: 'ok' });
    vi.mocked(acceptInvitation).mockResolvedValue({
      kind: 'success',
      organization: { organizationId: '1', name: 'Acme', status: 'active', closedTime: null, role: 'member' },
    });
    vi.mocked(bindMailFlow).mockResolvedValue({ kind: 'ok' });
    vi.mocked(refresh).mockResolvedValue({ kind: 'ok', value: undefined });

    const { default: AcceptInvitation } = await import('./AcceptInvitation.vue');
    const wrapper = mount(AcceptInvitation);
    await flushPromises();

    expect(wrapper.text()).toContain('处理失败');
    expect(vi.mocked(claimLinkFlow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(claimLinkFlow)).toHaveBeenCalledWith('accept-invitation', 'TOK123');

    await wrapper.find('button').trigger('click');
    await flushPromises();

    expect(vi.mocked(claimLinkFlow)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(claimLinkFlow)).toHaveBeenLastCalledWith('accept-invitation', 'TOK123');
    expect(vi.mocked(refresh)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bindMailFlow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(acceptInvitation)).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('已加入组织');
    expect(wrapper.text()).toContain('Acme');
  });
});