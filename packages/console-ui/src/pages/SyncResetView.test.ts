// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/linkFlows', () => ({
  claimLinkFlow: vi.fn(),
  bindMailFlow: vi.fn(),
  createSyncResetHandoff: vi.fn(),
}));

vi.mock('../api/consoleAuth', () => ({
  ensureCsrf: vi.fn(async () => 'csrf'),
  refresh: vi.fn(async () => ({ kind: 'ok', value: undefined })),
  getAccessToken: vi.fn(() => 'at'),
}));

import { claimLinkFlow, bindMailFlow, createSyncResetHandoff } from '../api/linkFlows';
import { refresh, ensureCsrf } from '../api/consoleAuth';

function setLocation(path: string): void {
  window.history.replaceState(null, '', path);
}

async function mountView() {
  const { default: SyncResetView } = await import('./SyncResetView.vue');
  return mount(SyncResetView);
}

beforeEach(() => {
  vi.mocked(claimLinkFlow).mockReset();
  vi.mocked(bindMailFlow).mockReset();
  vi.mocked(createSyncResetHandoff).mockReset();
  vi.mocked(refresh).mockReset();
  vi.mocked(ensureCsrf).mockReset();
  vi.mocked(refresh).mockResolvedValue({ kind: 'ok', value: undefined });
  vi.mocked(bindMailFlow).mockResolvedValue({ kind: 'ok' });
  vi.mocked(ensureCsrf).mockResolvedValue('csrf');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncResetView state machine', () => {
  it('retains the in-memory token across claim network failure and retries to ready', async () => {
    setLocation('/sync-reset?token=TOK123');
    vi.mocked(claimLinkFlow)
      .mockResolvedValueOnce({ kind: 'failure' })
      .mockResolvedValue({ kind: 'ok' });
    vi.mocked(createSyncResetHandoff).mockResolvedValue({
      kind: 'success',
      openUri: 'vscode://dbclient.sync/reset-after-loss?handoffTicket=abc',
      expiresTime: new Date(Date.now() + 900_000).toISOString(),
    });

    const wrapper = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('处理失败');
    expect(vi.mocked(claimLinkFlow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(claimLinkFlow)).toHaveBeenCalledWith('sync-reset', 'TOK123');

    await wrapper.find('button').trigger('click');
    await flushPromises();

    expect(vi.mocked(claimLinkFlow)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(claimLinkFlow)).toHaveBeenLastCalledWith('sync-reset', 'TOK123');
    expect(wrapper.text()).toContain('在 VS Code 中继续');
    wrapper.unmount();
  });

  it('already-logged-in path binds then shows the open VS Code button', async () => {
    setLocation('/sync-reset');
    vi.mocked(createSyncResetHandoff).mockResolvedValue({
      kind: 'success',
      openUri: 'vscode://dbclient.sync/reset-after-loss?handoffTicket=abc',
      expiresTime: new Date(Date.now() + 900_000).toISOString(),
    });

    const wrapper = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('在 VS Code 中继续');
    expect(vi.mocked(bindMailFlow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createSyncResetHandoff)).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('launch reuses the in-memory ticket on retry while unexpired', async () => {
    setLocation('/sync-reset');
    vi.mocked(createSyncResetHandoff).mockResolvedValue({
      kind: 'success',
      openUri: 'vscode://dbclient.sync/reset-after-loss?handoffTicket=tick',
      expiresTime: new Date(Date.now() + 900_000).toISOString(),
    });
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);

    const wrapper = await mountView();
    await flushPromises();

    const openBtn = wrapper.findAll('button').find((b) => b.text().includes('在 VS Code 中继续'))!;
    await openBtn.trigger('click');
    await flushPromises();
    expect(assign).toHaveBeenCalledWith('vscode://dbclient.sync/reset-after-loss?handoffTicket=tick');

    const retryBtn = wrapper.findAll('button').find((b) => b.text().includes('我已打开 VS Code，重试'))!;
    expect(retryBtn).toBeTruthy();
    await retryBtn.trigger('click');
    expect(assign).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('shows invalid state with both recovery paths', async () => {
    setLocation('/sync-reset?token=TOK123');
    vi.mocked(claimLinkFlow).mockResolvedValue({ kind: 'invalid' });

    const wrapper = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('重置链接无效或已过期');
    expect(wrapper.text()).toContain('重新打开邮件中的重置链接');
    expect(wrapper.text()).toContain('回到 VS Code 扩展');
  });

  it('shows rate-limited state with retry seconds on 429 handoff', async () => {
    setLocation('/sync-reset');
    vi.mocked(createSyncResetHandoff).mockResolvedValue({ kind: 'rate-limited', retryAfter: 7 });

    const wrapper = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('操作过于频繁');
    expect(wrapper.text()).toContain('7');
    wrapper.unmount();
  });

  it('does not launch an already-expired ticket from the ready state', async () => {
    setLocation('/sync-reset');
    vi.mocked(createSyncResetHandoff).mockResolvedValue({
      kind: 'success',
      openUri: 'vscode://dbclient.sync/reset-after-loss?handoffTicket=old',
      expiresTime: new Date(Date.now() - 1000).toISOString(),
    });
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);

    const wrapper = await mountView();
    await flushPromises();

    // 倒计时首 tick 即判过期：不再渲染可用深链按钮，转为恢复引导，且不唤起 VS Code。
    expect(wrapper.text()).not.toContain('在 VS Code 中继续');
    expect(wrapper.text()).toContain('连接凭证已过期');
    expect(assign).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows failure and retries when the initial CSRF fetch rejects', async () => {
    setLocation('/sync-reset');
    vi.mocked(claimLinkFlow).mockResolvedValue({ kind: 'ok' });
    vi.mocked(ensureCsrf).mockRejectedValueOnce(new Error('network')).mockResolvedValue('csrf');
    vi.mocked(createSyncResetHandoff).mockResolvedValue({
      kind: 'success',
      openUri: 'vscode://dbclient.sync/reset-after-loss?handoffTicket=r',
      expiresTime: new Date(Date.now() + 900_000).toISOString(),
    });

    const wrapper = await mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('处理失败');
    expect(vi.mocked(ensureCsrf)).toHaveBeenCalledTimes(1);

    await wrapper.find('button').trigger('click');
    await flushPromises();

    expect(vi.mocked(ensureCsrf)).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('在 VS Code 中继续');
    wrapper.unmount();
  });
});