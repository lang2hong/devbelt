// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../lib/router', async () => {
  const { reactive } = await import('vue');
  return {
    router: reactive({ pathname: '', name: null as string | null, params: {} as Record<string, string> }),
    navigate: vi.fn(),
    withBase: (p: string) => p,
  };
});

import { router } from '../lib/router';
import AdminNav from './AdminNav.vue';

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  router.name = null;
});

function groupTitles(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('.group-title').map((b) => b.text().replace('⌃', '').trim());
}

describe('AdminNav 折叠', () => {
  it('点击分组标题折叠/展开，并持久化到 localStorage', async () => {
    const wrapper = mount(AdminNav);
    await flushPromises();
    expect(groupTitles(wrapper)).toEqual(['运营', '商业化', 'AI', '系统']);

    const buttons = wrapper.findAll('.group-title');
    await buttons[3]!.trigger('click'); // 系统
    const linksContainer = wrapper.findAll('.group')[3]!.find('.group-links')!;
    expect(linksContainer.attributes('style')).toContain('display: none');
    expect(JSON.parse(localStorage.getItem('devbelt.admin.nav.collapsed')!)).toEqual(['系统']);

    await buttons[3]!.trigger('click');
    const style = wrapper.findAll('.group')[3]!.find('.group-links')!.attributes('style') ?? '';
    expect(style).not.toContain('display: none');
    expect(localStorage.getItem('devbelt.admin.nav.collapsed')).toBe('[]');
    wrapper.unmount();
  });

  it('当前路由所在分组保持展开（即使本地存为折叠）', async () => {
    localStorage.setItem('devbelt.admin.nav.collapsed', JSON.stringify(['运营']));
    router.name = 'admin-users';
    const wrapper = mount(AdminNav);
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('devbelt.admin.nav.collapsed')!)).toEqual([]);
    const opsLinks = wrapper.findAll('.group')[0]!.findAll('a');
    expect(opsLinks.map((a) => a.text())).toContain('用户');
    wrapper.unmount();
  });
});
