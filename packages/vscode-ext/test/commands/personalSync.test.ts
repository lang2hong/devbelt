import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  window: {},
  commands: { executeCommand: vi.fn(async () => {}) },
}));

import { initializePersonalSync, unlockPersonalSync, syncEntry, pullPersonalSync, pushPersonalSync, type PersonalSyncCommandDeps, type SyncSessionPort, type SyncUi } from '../../src/commands/personalSync';
import { SyncApiError } from '../../src/sync/e2e/client';
import type { InitialSyncMaterial } from '../../src/sync/keyLifecycle';
import type { StateDto } from '../../src/sync/e2e/types';

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
    syncNow: vi.fn(async () => ({ stage: 'ok' })),
    syncPull: vi.fn(async () => ({ stage: 'ok' })),
    syncPush: vi.fn(async () => ({ stage: 'ok' })),
    lock: vi.fn(),
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
    auth: { isLoggedIn: () => true, refreshEntitlement: vi.fn(async () => {}) },
    factory: { ensureSession: vi.fn(async () => session) },
    ui,
    createMaterial: vi.fn(async () => makeMaterial()),
    unlockDek: vi.fn(async () => makeMaterial().dek),
  };
  return { deps, ui, info, warn, error, errorAction };
}

describe('personal sync B1 commands', () => {
  it('400 SYNC_NOT_INITIALIZED initializes before showing the recovery code, then starts the first sync', async () => {
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
    expect(session.syncNow).toHaveBeenCalledTimes(1);
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
    expect(info).not.toHaveBeenCalledWith('Personal sync is unlocked and up to date.');

    confirm(true);
    await initializing;

    expect(session.syncNow).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Personal sync is unlocked and up to date.');
  });

  it('rejects initialization when a remote state already exists', async () => {
    const session = makeSession();
    const { deps, ui } = makeDeps(session);

    await initializePersonalSync(deps);

    expect(ui.promptSmp).not.toHaveBeenCalled();
    expect(session.initializeSync).not.toHaveBeenCalled();
  });

  it('unlocks only after a valid state and DEK are available', async () => {
    const session = makeSession({ pendingCleanup: { fromKeyEpoch: '1', toKeyEpoch: '2' } });
    const { deps, info } = makeDeps(session, ['sync secret!']);

    await unlockPersonalSync(deps);

    expect(deps.auth.refreshEntitlement).toHaveBeenCalledBefore(deps.factory.ensureSession as any);
    expect(deps.unlockDek).toHaveBeenCalledWith('7', '1', 'sync secret!', state);
    expect(session.unlockFromState).toHaveBeenCalledWith(state, expect.any(Uint8Array));
    expect(session.syncNow).not.toHaveBeenCalled(); // 解锁由 unlockFromState 内部调度首次同步，命令层不再重复
    expect(info).toHaveBeenCalledWith('Completed pending personal sync cleanup.');
    expect(info).toHaveBeenCalledWith('Personal sync is unlocked. Starting first sync in the background.');
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
    expect(second.error).toHaveBeenCalledWith('Personal sync could not be unlocked. Check the sync passphrase or encrypted state.');
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

  it('epoch-stale 且解锁失败 → 提供 Clear Local Sync 逃生舱按钮', async () => {
    const session = makeSession({ isUnlocked: false, epochStale: true });
    const { deps, errorAction } = makeDeps(session, ['sync secret!']);
    deps.unlockDek = vi.fn(async () => { throw new Error('gcm'); });
    errorAction.mockResolvedValue('Clear Local Sync Data');

    await unlockPersonalSync(deps);

    expect(errorAction).toHaveBeenCalled();
  });

  it('重启后（无 coordinator）本地 epoch 落后 + 解锁失败 → 仍提供逃生舱（R1）', async () => {
    const remoteState = { ...state, keyEpoch: '2' };
    const session = makeSession({
      isUnlocked: false,
      epochStale: false,
      localEpoch: '1',
      getRemoteState: vi.fn(async () => remoteState),
    });
    const { deps, errorAction } = makeDeps(session, ['sync secret!']);
    deps.unlockDek = vi.fn(async () => { throw new Error('gcm'); });
    errorAction.mockResolvedValue('Clear Local Sync Data');

    await unlockPersonalSync(deps);

    expect(errorAction).toHaveBeenCalled();
  });

  it('syncEntry: unlocked → immediate syncNow', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps } = makeDeps(session, []);
    await syncEntry(deps);
    expect(session.syncNow).toHaveBeenCalledTimes(1);
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

  it('pull/push: unlocked session invokes the matching phase', async () => {
    const session = makeSession({ isUnlocked: true });
    const { deps } = makeDeps(session, []);
    await pullPersonalSync(deps);
    await pushPersonalSync(deps);
    expect(session.syncPull).toHaveBeenCalledTimes(1);
    expect(session.syncPush).toHaveBeenCalledTimes(1);
  });
});
