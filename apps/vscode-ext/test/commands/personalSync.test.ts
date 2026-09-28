import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn(async () => {}) }));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  window: {},
  commands: { executeCommand: mocks.executeCommand },
}));

// 诊断日志依赖 vscode 输出通道；命令测试里 mock 掉，避免触发真实通道。
vi.mock('../../src/utils/diagnostics', () => ({ diagInfo: vi.fn(), diagWarn: vi.fn(), diagError: vi.fn() }));

import { initializePersonalSync, unlockPersonalSync, syncEntry, pullPersonalSync, pushPersonalSync, syncNowPersonalSync, resetLocalSync, type PersonalSyncCommandDeps, type SyncSessionPort, type SyncUi } from '../../src/commands/personalSync';
import { SyncApiError } from '@devbelt/db-host/sync/e2e/client';
import type { InitialSyncMaterial } from '@devbelt/db-host/sync/keyLifecycle';
import type { StateDto } from '@devbelt/db-host/sync/e2e/types';

const state: StateDto = {
  protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
  keyEpoch: '1', stateVersion: '1', changeSequence: '0',
  signPub: 'A'.repeat(43), recoverSignPub: 'B'.repeat(43),
  smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'C'.repeat(22), outputBytes: 32 },
  recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: 'D'.repeat(22), outputBytes: 32 },
  envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'E'.repeat(16), ciphertext: 'F'.repeat(43), tag: 'G'.repeat(22) },
  envelopeRecovery: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: 'H'.repeat(16), ciphertext: 'I'.repeat(43), tag: 'J'.repeat(22) },
  envelopeAccountVersion: '1',
  recoveryCodeSetTime: null,
};

function makeMaterial(): InitialSyncMaterial {
  return {
    dek: new Uint8Array(32).fill(7), signPub: 'A'.repeat(43), recoverSignPub: 'B'.repeat(43),
    smpKdf: state.smpKdf, recoveryKdf: state.recoveryKdf,
    envelopeSmp: state.envelopeSmp, envelopeRecovery: state.envelopeRecovery,
    envelopeAccount: state.envelopeSmp, accountRecoveryKey: new Uint8Array(32).fill(8),
  };
}

function makeSession(over: Partial<SyncSessionPort> = {}): SyncSessionPort {
  return {
    uid: '7',
    isUnlocked: false,
    pendingCleanup: undefined,
    epochStale: false,
    localEpoch: undefined,
    getRemoteState: vi.fn(async () => state),
    initializeSync: vi.fn(async () => {}),
    unlockFromState: vi.fn(async () => {}),
    tryRestoreUnlock: vi.fn(async () => false),
    syncNow: vi.fn(async () => ({ stage: 'ok' })),
    syncPull: vi.fn(async () => ({ stage: 'ok' })),
    syncPush: vi.fn(async () => ({ stage: 'ok' })),
    lock: vi.fn(),
    clearLocalState: vi.fn(async () => {}),
    ...over,
  };
}

function makeDeps(session: SyncSessionPort, inputs: Array<string | undefined> = ['sync secret!', 'sync secret!']) {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const errorAction = vi.fn();
  const ui: SyncUi = {
    promptSmp: vi.fn(async () => inputs.shift()),
    confirmRecoveryCode: vi.fn(async () => true),
    info, warn, error, errorAction,
  };
  const deps: PersonalSyncCommandDeps = {
    auth: { isLoggedIn: () => true, refreshEntitlement: vi.fn(async () => {}), getCachedEntitlement: () => undefined },
    factory: { ensureSession: vi.fn(async () => session) },
    ui,
    createMaterial: vi.fn(async () => makeMaterial()),
    unlockDek: vi.fn(async () => makeMaterial().dek),
  };
  return { deps, ui, info, warn, error, errorAction };
}

describe('personal sync B1 commands', () => {
  it('400 SYNC_NOT_INITIALIZED initializes and shows the recovery code, without auto-syncing', async () => {
    const callOrder: string[] = [];
    const session = makeSession({
      getRemoteState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }),
      initializeSync: vi.fn(async () => { callOrder.push('initialize'); }),
    });
    const { deps, ui } = makeDeps(session);
    ui.confirmRecoveryCode = vi.fn(async () => { callOrder.push('recovery'); return true; });

    await initializePersonalSync(deps);

    expect(deps.auth.refreshEntitlement).toHaveBeenCalledBefore(deps.factory.ensureSession as any);
    expect(ui.confirmRecoveryCode).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['initialize', 'recovery']);
    expect(session.initializeSync).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: 1, signPub: 'A'.repeat(43) }), expect.any(Uint8Array));
    // 初始化是纯初始化：不自动同步
    expect(session.syncNow).not.toHaveBeenCalled();
  });

  it('does not show recovery code when initialization fails, and zeroes temporary material', async () => {
    const material = makeMaterial();
    const recoveryRaw = new Uint8Array(32).fill(9);
    const session = makeSession({ getRemoteState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }), initializeSync: vi.fn(async () => { throw new Error('local persistence failed'); }) });
    const { deps, ui } = makeDeps(session);
    deps.createMaterial = vi.fn(async () => material);
    deps.newRecoveryCode = () => ({ code: 'recovery', raw: recoveryRaw });

    await initializePersonalSync(deps);

    expect(ui.confirmRecoveryCode).not.toHaveBeenCalled();
    expect(ui.warn).toHaveBeenCalledWith('Personal sync may have been initialized. Use Unlock Personal Sync instead of trying again.');
    expect(material.dek).toEqual(new Uint8Array(32));
    expect(recoveryRaw).toEqual(new Uint8Array(32));
    expect(session.syncNow).not.toHaveBeenCalled();
  });

  it('does not sync or report ready until recovery-code confirmation is explicit', async () => {
    const session = makeSession({ getRemoteState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }) });
    const { deps, ui, info, warn } = makeDeps(session);
    let confirm!: (value: boolean) => void;
    ui.confirmRecoveryCode = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { confirm = resolve; }));

    const initializing = initializePersonalSync(deps);
    await vi.waitFor(() => expect(ui.confirmRecoveryCode).toHaveBeenCalledTimes(2));

    expect(warn).toHaveBeenCalledWith('Save the recovery code and select “I saved it” to finish setup.');
    expect(session.syncNow).not.toHaveBeenCalled();

    confirm(true);
    await initializing;

    expect(session.syncNow).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Personal sync initialized.');
  });

  it('rejects initialization when a remote state already exists', async () => {
    const session = makeSession();
    const { deps, ui } = makeDeps(session);

    await initializePersonalSync(deps);

    expect(ui.promptSmp).not.toHaveBeenCalled();
    expect(session.initializeSync).not.toHaveBeenCalled();
  });

  it('unlockPersonalSync: tryRestoreUnlock succeeds → no passphrase prompt', async () => {
    const session = makeSession({ tryRestoreUnlock: vi.fn(async () => true) });
    const { deps, info } = makeDeps(session, []);
    await unlockPersonalSync(deps);
    expect(deps.ui.promptSmp).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Personal sync unlocked automatically (no passphrase needed).');
  });

  it('unlocks only after a valid state and DEK are available', async () => {
    const session = makeSession({ pendingCleanup: { fromKeyEpoch: '1', toKeyEpoch: '2' } });
    const { deps, info } = makeDeps(session, ['sync secret!']);

    await unlockPersonalSync(deps);

    expect(deps.auth.refreshEntitlement).toHaveBeenCalledBefore(deps.factory.ensureSession as any);
    expect(deps.unlockDek).toHaveBeenCalledWith('7', '1', 'sync secret!', state);
    expect(session.unlockFromState).toHaveBeenCalledWith(state, expect.any(Uint8Array));
    expect(session.syncNow).not.toHaveBeenCalled(); // 解锁是纯解锁：不自动同步
    expect(info).toHaveBeenCalledWith('Completed pending personal sync cleanup.');
    expect(info).toHaveBeenCalledWith('Personal sync unlocked.');
  });

  it('zeros the command-owned decrypted DEK after the session accepts it', async () => {
    const session = makeSession();
    const temporaryDek = new Uint8Array(32).fill(5);
    const { deps } = makeDeps(session, ['sync secret!']);
    deps.unlockDek = vi.fn(async () => temporaryDek);

    await unlockPersonalSync(deps);

    expect(session.unlockFromState).toHaveBeenCalledWith(state, temporaryDek);
    expect(temporaryDek).toEqual(new Uint8Array(32));
  });

  it('fails closed for corrupt state or invalid SMP envelope without starting sync', async () => {
    const corrupt = makeSession({ getRemoteState: vi.fn(async () => { throw new Error('malformed state'); }) });
    const first = makeDeps(corrupt, ['sync secret!']);
    await unlockPersonalSync(first.deps);
    expect(first.error).toHaveBeenCalledWith('Personal sync state is invalid or unavailable.');
    expect(corrupt.unlockFromState).not.toHaveBeenCalled();

    const encrypted = makeSession();
    const second = makeDeps(encrypted, ['wrong secret']);
    second.deps.unlockDek = vi.fn(async () => { throw new Error('GCM authentication failed'); });
    await unlockPersonalSync(second.deps);
    expect(second.errorAction).toHaveBeenCalledWith('Sync passphrase mismatch. It may have been changed on another device.', [
      'Re-enter', 'Use Recovery Code', 'Use Account', 'Reset Sync', 'Reset Local Sync',
    ]);
    expect(encrypted.unlockFromState).not.toHaveBeenCalled();
    expect(encrypted.syncNow).not.toHaveBeenCalled();
  });

  it('rejects blank, short, and overlong initialization SMPs by code point', async () => {
    for (const input of ['   ', 'short', 'a'.repeat(129)]) {
      const session = makeSession({ getRemoteState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }) });
      const { deps } = makeDeps(session, [input]);
      await initializePersonalSync(deps);
      expect(session.initializeSync).not.toHaveBeenCalled();
    }

    const emojiSmp = '😀'.repeat(12);
    const session = makeSession({ getRemoteState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }) });
    const { deps } = makeDeps(session, [emojiSmp, emojiSmp]);
    await initializePersonalSync(deps);
    expect(session.initializeSync).toHaveBeenCalledTimes(1);
  });

  it('does not repeat initialization or unlock prompts after session is unlocked', async () => {
    const session = makeSession({ isUnlocked: true });
    const init = makeDeps(session);
    await initializePersonalSync(init.deps);
    expect(init.ui.promptSmp).not.toHaveBeenCalled();
    expect(init.info).toHaveBeenCalledWith('Personal sync is already unlocked and running.');

    const unlock = makeDeps(session);
    await unlockPersonalSync(unlock.deps);
    expect(unlock.ui.promptSmp).not.toHaveBeenCalled();
    expect(unlock.info).toHaveBeenCalledWith('Personal sync is already unlocked and running.');
  });

  it('epoch-stale（解锁态）时重新解锁：先 lock 再走 SMP 解锁流程', async () => {
    const session = makeSession({ isUnlocked: true, epochStale: true, lock: vi.fn() });
    const { deps } = makeDeps(session, ['sync secret!']);
    await unlockPersonalSync(deps);

    expect(session.lock).toHaveBeenCalledTimes(1);
    expect(deps.unlockDek).toHaveBeenCalledWith('7', '1', 'sync secret!', state);
    expect(session.unlockFromState).toHaveBeenCalledWith(state, expect.any(Uint8Array));
  });

  it('epoch-stale 且解锁失败 → 提示数据已重置并触发 resetSync', async () => {
    const session = makeSession({ isUnlocked: false, epochStale: true });
    const { deps, errorAction } = makeDeps(session, ['sync secret!']);
    deps.unlockDek = vi.fn(async () => { throw new Error('gcm'); });
    errorAction.mockResolvedValue('Reset Sync');

    await unlockPersonalSync(deps);

    expect(errorAction).toHaveBeenCalled();
    expect(mocks.executeCommand).toHaveBeenCalledWith('devbelt.resetSync');
  });

  it('重启后（无 coordinator）本地 epoch 落后 + 解锁失败 → 仍触发 resetSync（R1）', async () => {
    const remoteState = { ...state, keyEpoch: '2' };
    const session = makeSession({
      isUnlocked: false,
      epochStale: false,
      localEpoch: '1',
      getRemoteState: vi.fn(async () => remoteState),
    });
    const { deps, errorAction } = makeDeps(session, ['sync secret!']);
    deps.unlockDek = vi.fn(async () => { throw new Error('gcm'); });
    errorAction.mockResolvedValue('Reset Sync');

    await unlockPersonalSync(deps);

    expect(errorAction).toHaveBeenCalled();
    expect(mocks.executeCommand).toHaveBeenCalledWith('devbelt.resetSync');
  });

  it('口令不一致（非 epoch 前进）→ 弹 4 按钮并分发', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, errorAction } = makeDeps(session, ['sync secret!']);
    deps.unlockDek = vi.fn(async () => { throw new Error('gcm'); });
    errorAction.mockResolvedValue('Use Recovery Code');

    await unlockPersonalSync(deps);

    expect(errorAction).toHaveBeenCalledWith('Sync passphrase mismatch. It may have been changed on another device.', [
      'Re-enter', 'Use Recovery Code', 'Use Account', 'Reset Sync', 'Reset Local Sync',
    ]);
    expect(mocks.executeCommand).toHaveBeenCalledWith('devbelt.recoverSync');
  });

  it('syncEntry: already unlocked → informs, does not auto-sync', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, info } = makeDeps(session, []);
    await syncEntry(deps);
    expect(session.syncNow).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Personal sync is already unlocked and running.');
    expect(deps.ui.promptSmp).not.toHaveBeenCalled();
  });

  it('syncEntry: locked with a remote state (second device) → unlock flow, not initialize', async () => {
    const session = makeSession({ isUnlocked: false, localEpoch: undefined });
    const { deps } = makeDeps(session, ['sync secret!']);
    await syncEntry(deps);
    expect(session.initializeSync).not.toHaveBeenCalled();
    expect(deps.ui.promptSmp).toHaveBeenCalled();
    expect(session.unlockFromState).toHaveBeenCalledWith(state, expect.any(Uint8Array));
  });

  it('syncEntry: locked with no remote state → initialize flow', async () => {
    const session = makeSession({
      isUnlocked: false,
      localEpoch: undefined,
      getRemoteState: vi.fn(async () => { throw new SyncApiError(400, 'SYNC_NOT_INITIALIZED'); }),
    });
    const { deps } = makeDeps(session);
    await syncEntry(deps);
    expect(session.initializeSync).toHaveBeenCalledTimes(1);
    expect(session.unlockFromState).not.toHaveBeenCalled();
  });

  it('pull/push: locked session warns and does not run', async () => {
    const session = makeSession({ isUnlocked: false });
    const { deps, warn } = makeDeps(session, []);
    await pullPersonalSync(deps);
    await pushPersonalSync(deps);
    expect(session.syncPull).not.toHaveBeenCalled();
    expect(session.syncPush).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('pull/push: unlocked session invokes the matching phase and reports per-op', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, info } = makeDeps(session, []);
    await pullPersonalSync(deps);
    await pushPersonalSync(deps);
    expect(session.syncPull).toHaveBeenCalledTimes(1);
    expect(session.syncPush).toHaveBeenCalledTimes(1);
    // 分操作提示，不再共用同一句
    expect(info).toHaveBeenCalledWith('Pulled remote changes.');
    expect(info).toHaveBeenCalledWith('Pushed local changes.');
  });

  it('syncNow: explicit run waits and reports its own result', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps, info } = makeDeps(session, []);
    await syncNowPersonalSync(deps);
    expect(session.syncNow).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Sync complete.');
  });

  it('pull/push: conflict opens the conflict resolver instead of a retry warning', async () => {
    const session = makeSession({
      isUnlocked: true,
      syncPull: vi.fn(async () => ({ stage: 'conflict' })),
      syncPush: vi.fn(async () => ({ stage: 'conflict' })),
    });
    const { deps, warn } = makeDeps(session, []);
    mocks.executeCommand.mockClear();

    await pullPersonalSync(deps);
    await pushPersonalSync(deps);

    expect(mocks.executeCommand).toHaveBeenCalledTimes(2);
    expect(mocks.executeCommand).toHaveBeenCalledWith('devbelt.resolveConflicts');
    expect(warn).not.toHaveBeenCalled();
  });

  it('resetLocalSync: confirms locally, clears local state, and makes zero sync requests', async () => {
    const session = makeSession();
    const { deps, errorAction, info } = makeDeps(session, []);
    errorAction.mockResolvedValue('Reset Local Sync');

    await resetLocalSync(deps);

    expect(session.clearLocalState).toHaveBeenCalledTimes(1);
    expect(session.getRemoteState).not.toHaveBeenCalled();
    expect(session.syncNow).not.toHaveBeenCalled();
    expect(deps.auth.refreshEntitlement).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Local sync data cleared.');
  });

  it('resetLocalSync: dismissing the confirmation does nothing', async () => {
    const session = makeSession();
    const { deps, errorAction } = makeDeps(session, []);
    errorAction.mockResolvedValue(undefined);

    await resetLocalSync(deps);

    expect(session.clearLocalState).not.toHaveBeenCalled();
  });
});
