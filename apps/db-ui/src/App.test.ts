// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('@devkit/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshSession: vi.fn(async () => ({ kind: 'ok' })),
  getAccessToken: vi.fn(() => 'tok'),
  ensureCsrf: vi.fn(async () => ''),
  logout: vi.fn(async () => ({ kind: 'ok' as const })),
}));

vi.mock('./api/me', () => ({
  me: vi.fn(),
}));

import { me } from './api/me';
import { logout } from '@devkit/auth-client';
import App from './App.vue';

function consoleMe(platformAdmin: boolean) {
  return {
    kind: 'ok' as const,
    value: {
      user: { userId: '1', email: 'a@b.com', displayName: null, emailVerified: true, status: 'active', lastLoginTime: null },
      platformAdmin,
      subscription: null,
      organizations: [],
    },
  };
}

beforeEach(() => {
  vi.mocked(me).mockReset();
  vi.mocked(logout).mockReset();
  vi.mocked(logout).mockResolvedValue({ kind: 'ok' });
});

describe('logout', () => {
  it('warns and stays when logout fails (no silent redirect)', async () => {
    vi.mocked(me).mockResolvedValue(consoleMe(true));
    vi.mocked(logout).mockResolvedValue({ kind: 'failure' });
    const wrapper = mount(App);
    await flushPromises();
    const btn = wrapper.findAll('button').find((b) => b.text().trim() === '登出');
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('登出请求未得到服务器确认');
  });
});