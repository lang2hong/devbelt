// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
  sessionSet: vi.fn(),
  sessionClear: vi.fn(),
  unlock: vi.fn(),
  importKey: vi.fn(),
  totpCode: vi.fn(),
  totpSecondsLeft: vi.fn(),
  openRecord: vi.fn(),
  getE2eeParams: vi.fn(),
  getSyncRecords: vi.fn(),
}));

vi.mock('@devbelt/auth-client', () => ({
  unlockDekBrowser: mocks.unlock,
  importTotpKey: mocks.importKey,
  totpCodeForKey: mocks.totpCode,
  totpSecondsLeft: mocks.totpSecondsLeft,
  openCipherRecord: mocks.openRecord,
  DekSession: class {
    set = mocks.sessionSet;
    clear = mocks.sessionClear;
    get = (): Uint8Array => new Uint8Array(32).fill(1);
    get isUnlocked(): boolean { return true; }
  },
}));

vi.mock('../api/sync', () => ({
  getE2eeParams: mocks.getE2eeParams,
  getSyncRecords: mocks.getSyncRecords,
}));

import AuthenticatorView from './AuthenticatorView.vue';

const E2EE_PARAMS = {
  initialized: true,
  keyEpoch: '1',
  smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA', outputBytes: 32 },
  envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA' },
};

const ENTRY_RECORD = { recordId: 'r1', version: '1', changeSequence: '1', deleteTime: null };
const ENTRY_PAYLOAD = { type: 'authenticatorEntry', issuer: 'Acme', account: 'a@b', algorithm: 'SHA1', digits: 6, period: 30, secret: 'JBSWY3DPEHPK3PXP' };

function mountView(user: { userId: string } | null): VueWrapper {
  return mount(AuthenticatorView, { props: { user } });
}

function buttonByText(wrapper: VueWrapper, text: string) {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn;
}

beforeEach(() => {
  vi.clearAllMocks();
  try { localStorage.clear(); } catch { /* ignore */ } // 隔离「记住解锁」缓存

  mocks.getE2eeParams.mockResolvedValue({ kind: 'ok', value: E2EE_PARAMS });
  mocks.unlock.mockResolvedValue(new Uint8Array(32).fill(1));
  mocks.getSyncRecords.mockResolvedValue({ kind: 'ok', value: { records: [ENTRY_RECORD], nextAfter: undefined } });
  mocks.openRecord.mockResolvedValue(ENTRY_PAYLOAD);
  mocks.importKey.mockResolvedValue({} as CryptoKey);
  mocks.totpCode.mockResolvedValue('654321');
  mocks.totpSecondsLeft.mockImplementation((nowMs: number, period: 30 | 60 = 30) => period - (Math.floor(nowMs / 1000) % period));
});

describe('AuthenticatorView', () => {
  it('unlocks, decrypts and renders the code', async () => {
    const wrapper = mountView({ userId: '7' });
    await wrapper.find('input').setValue('smp');
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();

    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    expect(mocks.sessionSet).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Acme');
    expect(wrapper.text()).toContain('654321');
    wrapper.unmount();
  });

  it('shows a loading hint until records are decrypted', async () => {
    let resolvePage!: (v: unknown) => void;
    mocks.getSyncRecords.mockReturnValue(new Promise((r) => { resolvePage = r; }));
    const wrapper = mountView({ userId: '7' });
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('正在解密…');
    expect(wrapper.text()).not.toContain('暂无验证器条目');

    resolvePage({ kind: 'ok', value: { records: [ENTRY_RECORD], nextAfter: undefined } });
    await flushPromises();
    expect(wrapper.text()).toContain('Acme');
    wrapper.unmount();
  });

  it('guards against double submit while busy', async () => {
    let resolveUnlock!: (v: Uint8Array) => void;
    mocks.unlock.mockReturnValue(new Promise<Uint8Array>((r) => { resolveUnlock = r; }));
    const wrapper = mountView({ userId: '7' });
    await wrapper.find('input').setValue('smp');

    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises(); // 已进入 awaiting unlockDekBrowser
    await buttonByText(wrapper, '解锁中…').trigger('click');
    resolveUnlock(new Uint8Array(32).fill(1));
    await flushPromises();

    expect(mocks.unlock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('shows an error and clears the session when unlock fails', async () => {
    mocks.getE2eeParams.mockResolvedValue({ kind: 'unauthorized' });
    const wrapper = mountView({ userId: '7' });
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();

    expect(mocks.sessionClear).toHaveBeenCalled();
    expect(wrapper.text()).toContain('无法获取同步材料');
    expect(wrapper.find('input').exists()).toBe(true);
    wrapper.unmount();
  });

  it('clears the DEK and SMP on lock', async () => {
    const wrapper = mountView({ userId: '7' });
    await wrapper.find('input').setValue('smp');
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();
    mocks.sessionClear.mockClear();

    await buttonByText(wrapper, '锁定').trigger('click');
    expect(mocks.sessionClear).toHaveBeenCalledTimes(1);
    expect(wrapper.find('input').exists()).toBe(true);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });

  it('shows copy feedback after copying a code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const wrapper = mountView({ userId: '7' });
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();

    await wrapper.find('.card').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('654321');
    expect(wrapper.text()).toContain('已复制');
    wrapper.unmount();
  });

  it('remembers the unlock in localStorage and restores without re-entering SMP', async () => {
    const w1 = mountView({ userId: '7' });
    await w1.find('input').setValue('smp');
    await buttonByText(w1, '解锁').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('devbelt.authenticator.dek')).toBeTruthy();
    w1.unmount();

    mocks.unlock.mockClear();
    const w2 = mountView({ userId: '7' });
    await flushPromises();
    expect(mocks.unlock).not.toHaveBeenCalled(); // 命中缓存，跳过 Argon2id
    expect(w2.text()).toContain('654321');
    w2.unmount();
  });

  it('does not persist when 记住解锁 is unchecked', async () => {
    const wrapper = mountView({ userId: '7' });
    await wrapper.find('input[type="checkbox"]').setValue(false);
    await wrapper.find('input:not([type="checkbox"])').setValue('smp');
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('devbelt.authenticator.dek')).toBeNull();
    wrapper.unmount();
  });

  it('clears the saved unlock on explicit lock', async () => {
    const wrapper = mountView({ userId: '7' });
    await wrapper.find('input').setValue('smp');
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('devbelt.authenticator.dek')).toBeTruthy();
    await buttonByText(wrapper, '锁定').trigger('click');
    expect(localStorage.getItem('devbelt.authenticator.dek')).toBeNull();
    wrapper.unmount();
  });

  it('does not write back the DEK when the user logs out mid-unlock', async () => {
    let resolveUnlock!: (v: Uint8Array) => void;
    mocks.unlock.mockReturnValue(new Promise<Uint8Array>((r) => { resolveUnlock = r; }));
    const wrapper = mountView({ userId: '7' });
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises(); // awaiting unlockDekBrowser

    await wrapper.setProps({ user: null }); // watch → lock() 作废在途解锁
    resolveUnlock(new Uint8Array(32).fill(1));
    await flushPromises();

    expect(mocks.sessionSet).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('does not write back the DEK when unmounted mid-unlock', async () => {
    let resolveUnlock!: (v: Uint8Array) => void;
    mocks.unlock.mockReturnValue(new Promise<Uint8Array>((r) => { resolveUnlock = r; }));
    const wrapper = mountView({ userId: '7' });
    await buttonByText(wrapper, '解锁').trigger('click');
    await flushPromises(); // awaiting unlockDekBrowser

    wrapper.unmount();
    resolveUnlock(new Uint8Array(32).fill(1));
    await flushPromises();

    expect(mocks.sessionSet).not.toHaveBeenCalled();
  });
});
