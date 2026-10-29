import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  ViewColumn: { Active: 1 },
}));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { reveal: vi.fn() };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    dispose(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/diagnostics', () => ({ diagInfo: vi.fn(), diagWarn: vi.fn(), diagError: vi.fn() }));

import { LoginFormView } from '../../src/sync/loginFormView';
import { diagError } from '../../src/utils/diagnostics';

function viewFor(login: () => Promise<void>): any {
  const auth = { login, register: vi.fn(), confirmEmail: vi.fn(), resendVerification: vi.fn() };
  return new (LoginFormView as any)(auth);
}

async function submit(view: any): Promise<any> {
  await view.handleMessage({ type: 'ready' });
  await view.handleMessage({ type: 'login', email: 'a@b.c', password: 'pw-123456' });
  return view.post.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'error').at(-1);
}

describe('LoginFormView 错误展示', () => {
  it('网络故障（fetch failed）→ 本地化说明，不是英文技术串', async () => {
    const view = viewFor(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } }); });
    const err = await submit(view);
    expect(err.message).toBe('Cannot reach the server. Check your network and try again.');
  });

  it('只有 cause 里带网络错误码（message 不含）也识别为网络故障', async () => {
    const view = viewFor(async () => { throw Object.assign(new Error('Request failed'), { cause: { code: 'ETIMEDOUT' } }); });
    const err = await submit(view);
    expect(err.message).toContain('Cannot reach the server');
  });

  it('服务端业务错误（密码错误）保持原文', async () => {
    const view = viewFor(async () => { throw new Error('Invalid email or password'); });
    const err = await submit(view);
    expect(err.message).toBe('Invalid email or password');
  });

  it('网络故障的原始原因仍写入诊断日志', async () => {
    vi.mocked(diagError).mockClear();
    const view = viewFor(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } }); });
    await submit(view);
    expect(JSON.stringify(vi.mocked(diagError).mock.calls)).toContain('ENOTFOUND');
  });

  it('套餐权益错误仍走专用文案', async () => {
    const view = viewFor(async () => { throw Object.assign(new Error('forbidden'), { code: 'PERSONAL_FEATURE_REQUIRED' }); });
    const err = await submit(view);
    expect(err.message).toContain('device limit');
  });
});
