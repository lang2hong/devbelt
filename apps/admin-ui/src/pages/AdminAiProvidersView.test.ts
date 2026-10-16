// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/admin', () => ({
  listAdminAiProviders: vi.fn(),
  createAdminAiProvider: vi.fn(),
  updateAdminAiProvider: vi.fn(),
}));
vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(async () => 'csrf'),
  setAccessToken: vi.fn(),
}));

import { createAdminAiProvider, listAdminAiProviders, updateAdminAiProvider } from '../api/admin';
import AdminAiProvidersView from './AdminAiProvidersView.vue';

const P = {
  code: 'openai',
  name: { en: 'OpenAI', zh: 'OpenAI' },
  baseUrl: 'https://api.openai.com/v1',
  models: [{ id: 'gpt-4o-mini', default: true }],
  status: 'active' as const,
  sortOrder: 10,
};

function docButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === text) as HTMLButtonElement | undefined;
}
function docInput(ph: string): HTMLInputElement {
  return document.querySelector(`input[placeholder^="${ph}"]`) as HTMLInputElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listAdminAiProviders).mockReset().mockResolvedValue({ kind: 'ok', value: { items: [P] } });
  vi.mocked(createAdminAiProvider).mockReset();
  vi.mocked(updateAdminAiProvider).mockReset();
});

describe('AdminAiProvidersView', () => {
  it('列表展示厂商、地址与默认模型标记', async () => {
    const w = mount(AdminAiProvidersView, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain('openai');
    expect(w.text()).toContain('https://api.openai.com/v1');
    expect(w.text()).toContain('gpt-4o-mini*');
  });

  it('停用：以固定原因调用更新接口', async () => {
    vi.mocked(updateAdminAiProvider).mockResolvedValue({ kind: 'ok', value: { provider: { ...P, status: 'disabled' } } });
    const w = mount(AdminAiProvidersView, { attachTo: document.body });
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === '停用')!.trigger('click');
    await flushPromises();
    expect(updateAdminAiProvider).toHaveBeenCalledWith('openai', { status: 'disabled' }, '运营停用', expect.any(String), 'csrf');
  });

  it('新增：非 https 地址与缺原因在前端被拦截，不发请求', async () => {
    mount(AdminAiProvidersView, { attachTo: document.body });
    await flushPromises();
    docButton('新增厂商')!.click();
    await flushPromises();
    const set = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event('input'));
    };
    set(docInput('acme'), 'acme');
    set(docInput('如 Acme 云'), '甲');
    set(docInput('Acme Cloud'), 'Acme');
    set(docInput('https://api.acme.com/v1'), 'http://insecure.example.com/v1');
    set(document.querySelector('textarea')!, '*m1');
    set(docInput('例如：新增官方厂商目录'), '新增');
    docButton('保存')!.click();
    await flushPromises();
    expect(createAdminAiProvider).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('https://');
  });
});
