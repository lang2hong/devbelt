// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('./session', () => ({
  refreshSession: vi.fn(async () => ({ kind: 'ok' })),
}));

vi.mock('./api/consoleAuth', () => ({
  getAccessToken: vi.fn(() => 'tok'),
  ensureCsrf: vi.fn(async () => ''),
  logout: vi.fn(async () => {}),
}));

vi.mock('./api/me', () => ({
  me: vi.fn(),
}));

import { me } from './api/me';
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
});

describe('platform admin nav gate', () => {
  it('does not render the admin entry for a non-admin', async () => {
    vi.mocked(me).mockResolvedValue(consoleMe(false));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).not.toContain('管理');
  });

  it('renders the admin entry for a platform admin', async () => {
    vi.mocked(me).mockResolvedValue(consoleMe(true));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('管理');
  });
});