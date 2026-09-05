import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: () => 'en' }) },
  window: {},
  commands: {},
}));

import { initializePersonalSync, unlockPersonalSync, type PersonalSyncCommandDeps, type SyncSessionPort, type SyncUi } from '../../src/commands/personalSync';
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
  recoveryCodeSetTime: null,
};

function makeMaterial(): InitialSyncMaterial {
  return {
    dek: new Uint8Array(32).fill(7), signPub: 'A'.repeat(43), recoverSignPub: 'B'.repeat(43),
    smpKdf: state.smpKdf, recoveryKdf: state.recoveryKdf,
    envelopeSmp: state.envelopeSmp, envelopeRecovery: state.envelopeRecovery,
  };
}

function makeSession(over: Partial<SyncSessionPort> = {}): SyncSessionPort {
  return {
    uid: '7',
    isUnlocked: false,
    pendingCleanup: undefined,
    getRemoteState: vi.fn(async () => state),
    initializeSync: vi.fn(async () => {}),
    unlockFromState: vi.fn(async () => {}),
    syncNow: vi.fn(async () => ({ stage: 'ok' })),
    ...over,
  };
}

function makeDeps(session: SyncSessionPort, inputs: Array<string | undefined> = ['sync secret!', 'sync secret!']) {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const ui: SyncUi = {
    promptSmp: vi.fn(async () => inputs.shift()),
    confirmRecoveryCode: vi.fn(async () => true),
    info, warn, error,
  };
  const deps: PersonalSyncCommandDeps = {
    auth: { isLoggedIn: () => true, refreshEntitlement: vi.fn(async () => {}) },
    factory: { ensureSession: vi.fn(async () => session) },
    ui,
    createMaterial: vi.fn(async () => makeMaterial()),
    unlockDek: vi.fn(async () => makeMaterial().dek),
  };
  return { deps, ui, info, warn, error };
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
    expect(session.syncNow).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Completed pending personal sync cleanup.');
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
});
