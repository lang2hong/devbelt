// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { OrgSummary, Member, Invitation } from '../api/organizations';

vi.mock('../api/organizations', () => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  closeOrganization: vi.fn(),
  leaveOrganization: vi.fn(),
  listMembers: vi.fn(),
  assignRole: vi.fn(),
  removeMember: vi.fn(),
  listInvitations: vi.fn(),
  inviteMember: vi.fn(),
  revokeInvitation: vi.fn(),
}));

vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCsrf: vi.fn(),
  setAccessToken: vi.fn(),
}));

import {
  getOrganization,
  listMembers,
  listInvitations,
  closeOrganization,
} from '../api/organizations';
import { ensureCsrf } from '@devbelt/auth-client';
import OrganizationDetailView from './OrganizationDetailView.vue';

function org(name: string, role: string): OrgSummary {
  return { organizationId: name === 'Org A' ? 'a' : 'b', name, status: 'active', closedTime: null, role };
}

const invite = (email: string): Invitation => ({
  invitationId: `inv-${email}`,
  email,
  role: 'member',
  expiresTime: '2026-01-01T00:00:00.000Z',
});

const emptyMembers: Member[] = [];

beforeEach(() => {
  vi.mocked(getOrganization).mockReset();
  vi.mocked(listMembers).mockReset();
  vi.mocked(listInvitations).mockReset();
  vi.mocked(closeOrganization).mockReset();
  vi.mocked(ensureCsrf).mockReset();
  vi.mocked(ensureCsrf).mockResolvedValue('csrf');
});

describe('OrganizationDetailView 组织切换', () => {
  it('切换组织时清空旧邀请；新组织邀请加载失败时不残留旧数据', async () => {
    vi.mocked(getOrganization).mockImplementation(async (id) => ({
      kind: 'ok',
      value: org(id === 'a' ? 'Org A' : 'Org B', 'admin'),
    }));
    vi.mocked(listMembers).mockResolvedValue({ kind: 'ok', value: emptyMembers });
    vi.mocked(listInvitations).mockImplementation(async (id) =>
      id === 'a' ? { kind: 'ok', value: [invite('a@x.com')] } : { kind: 'failure' },
    );

    const wrapper = mount(OrganizationDetailView, { props: { organizationId: 'a' } });
    await flushPromises();
    expect(wrapper.text()).toContain('a@x.com');

    await wrapper.setProps({ organizationId: 'b' });
    await flushPromises();

    expect(wrapper.text()).not.toContain('a@x.com');
    expect(wrapper.text()).toContain('邀请列表加载失败');
    expect(wrapper.text()).toContain('Org B');
  });

  it('慢响应在后到达时不覆盖新组织数据', async () => {
    let resolveA!: (v: { kind: 'ok'; value: OrgSummary }) => void;
    let resolveB!: (v: { kind: 'ok'; value: OrgSummary }) => void;
    const pa = new Promise<{ kind: 'ok'; value: OrgSummary }>((r) => { resolveA = r; });
    const pb = new Promise<{ kind: 'ok'; value: OrgSummary }>((r) => { resolveB = r; });

    vi.mocked(getOrganization).mockImplementation(async (id) => (id === 'a' ? pa : pb));
    vi.mocked(listMembers).mockResolvedValue({ kind: 'ok', value: emptyMembers });
    vi.mocked(listInvitations).mockResolvedValue({ kind: 'ok', value: [] });

    const wrapper = mount(OrganizationDetailView, { props: { organizationId: 'a' } });
    await wrapper.setProps({ organizationId: 'b' });

    resolveB({ kind: 'ok', value: org('Org B', 'member') });
    await flushPromises();
    expect(wrapper.text()).toContain('Org B');

    resolveA({ kind: 'ok', value: org('Org A', 'admin') });
    await flushPromises();

    expect(wrapper.text()).toContain('Org B');
    expect(wrapper.text()).not.toContain('Org A');
  });

  it('确认关闭后切换组织，仍关闭原组织而非新组织', async () => {
    let resolveCsrf!: (v: string) => void;
    const csrfPromise = new Promise<string>((r) => { resolveCsrf = r; });
    vi.mocked(ensureCsrf).mockReturnValue(csrfPromise);

    vi.mocked(getOrganization).mockImplementation(async (id) => ({
      kind: 'ok',
      value: org(id === 'a' ? 'Org A' : 'Org B', 'admin'),
    }));
    vi.mocked(listMembers).mockResolvedValue({ kind: 'ok', value: emptyMembers });
    vi.mocked(listInvitations).mockResolvedValue({ kind: 'ok', value: [] });
    vi.mocked(closeOrganization).mockResolvedValue({ kind: 'ok', value: undefined });

    const wrapper = mount(OrganizationDetailView, { props: { organizationId: 'a' }, attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '关闭组织')!.trigger('click');
    await flushPromises();
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '确认关闭')!;
    confirmBtn.click();

    await wrapper.setProps({ organizationId: 'b' });
    resolveCsrf('csrf');
    await flushPromises();

expect(closeOrganization).toHaveBeenCalledWith('a', expect.anything(), expect.anything());
    expect(closeOrganization).not.toHaveBeenCalledWith('b', expect.anything(), expect.anything());
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('打开关闭组织确认框后切换路由，确认框自动关闭（不残留在新组织页面上）', async () => {
    vi.mocked(getOrganization).mockImplementation(async (id) => ({
      kind: 'ok',
      value: org(id === 'a' ? 'Org A' : 'Org B', 'admin'),
    }));
    vi.mocked(listMembers).mockResolvedValue({ kind: 'ok', value: emptyMembers });
    vi.mocked(listInvitations).mockResolvedValue({ kind: 'ok', value: [] });

    const wrapper = mount(OrganizationDetailView, { props: { organizationId: 'a' }, attachTo: document.body });
    await flushPromises();

    await wrapper.findAll('button').find((b) => b.text().trim() === '关闭组织')!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('确认关闭「Org A」');

    await wrapper.setProps({ organizationId: 'b' });
    await flushPromises();

    expect(document.body.textContent).not.toContain('确认关闭「Org A」');
    wrapper.unmount();
    document.body.innerHTML = '';
  });
});