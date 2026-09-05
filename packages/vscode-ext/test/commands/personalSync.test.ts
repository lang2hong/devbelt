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

const material: InitialSyncMaterial = {
  dek: new Uint8Array(32), signPub: 'A'.repeat(43), recoverSignPub: 'B'.repeat(43),
  smpKdf: state.smpKdf, recoveryKdf: state.recoveryKdf,
  envelopeSmp: state.envelopeSmp, envelopeRecovery: state.envelopeRecovery,
};

function makeSession(over: Partial<SyncSessionPort> = {}): SyncSessionPort {
  return {
    uid: '7',
    pendingCleanup: undefined,
    getRemoteState: vi.fn(async () => state),
    initializeSync: vi.fn(async () => {}),
    unlockFromState: vi.fn(async () => {}),
    syncNow: vi.fn(async () => ({ stage: 'ok' })),
    ...over,
  };
}

function makeDeps(session: SyncSessionPort, inputs: Array<string | undefined> = ['sync secret', 'sync secret']) {
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
    createMaterial: vi.fn(async () => material),
    unlockDek: vi.fn(async () => material.dek),
  };
  return { deps, ui, info, warn, error };
}

describe('personal sync B1 commands', () => {
  it('initializes only after recovery-code confirmation, then starts the first sync', async () => {
    const session = makeSession({ getRemoteState: vi.fn(async () => { throw new SyncApiError(404, 'SYNC_NOT_INITIALIZED'); }) });
    const { deps, ui } = makeDeps(session);

    await initializePersonalSync(deps);

    expect(deps.auth.refreshEntitlement).toHaveBeenCalledBefore(deps.factory.ensureSession as any);
    expect(ui.confirmRecoveryCode).toHaveBeenCalledTimes(1);
    expect(session.initializeSync).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: 1, signPub: material.signPub }), material.dek);
    expect(session.syncNow).toHaveBeenCalledTimes(1);
  });

  it('does not initialize when recovery code is not confirmed', async () => {
    const session = makeSession({ getRemoteState: vi.fn(async () => { throw new SyncApiError(404, 'SYNC_NOT_INITIALIZED'); }) });
    const { deps, ui } = makeDeps(session);
    ui.confirmRecoveryCode = vi.fn(async () => false);

    await initializePersonalSync(deps);

    expect(deps.createMaterial).not.toHaveBeenCalled();
    expect(session.initializeSync).not.toHaveBeenCalled();
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
    const { deps, info } = makeDeps(session, ['sync secret']);

    await unlockPersonalSync(deps);

    expect(deps.auth.refreshEntitlement).toHaveBeenCalledBefore(deps.factory.ensureSession as any);
    expect(deps.unlockDek).toHaveBeenCalledWith('7', '1', 'sync secret', state);
    expect(session.unlockFromState).toHaveBeenCalledWith(state, material.dek);
    expect(session.syncNow).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Completed pending personal sync cleanup.');
  });

  it('fails closed for corrupt state or invalid SMP envelope without starting sync', async () => {
    const corrupt = makeSession({ getRemoteState: vi.fn(async () => { throw new Error('malformed state'); }) });
    const first = makeDeps(corrupt, ['sync secret']);
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
});
