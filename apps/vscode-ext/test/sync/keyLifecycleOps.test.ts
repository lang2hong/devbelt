import { describe, expect, it, vi } from 'vitest';
import { KeyLifecycleOps, type KeyLifecycleDeps } from '@devbelt/db-host/sync/keyLifecycleOps';
import type { StateDto } from '@devbelt/db-host/sync/e2e/types';
import type { SyncStateSnapshot } from '@devbelt/db-host/sync/e2e/stateStore';

const kl = vi.hoisted(() => ({
  createInitialMaterial: vi.fn(),
  newRecoveryCode: vi.fn(),
  unlockDek: vi.fn(),
  buildChangeKeyMaterial: vi.fn(),
  buildRecoverMaterial: vi.fn(),
  buildRecoverByAccountMaterial: vi.fn(),
  newStateFromMaterial: vi.fn(),
}));

vi.mock('@devbelt/db-host/sync/keyLifecycle', () => ({
  createInitialMaterial: kl.createInitialMaterial,
  newRecoveryCode: kl.newRecoveryCode,
  unlockDek: kl.unlockDek,
  buildChangeKeyMaterial: kl.buildChangeKeyMaterial,
  buildRecoverMaterial: kl.buildRecoverMaterial,
  buildRecoverByAccountMaterial: kl.buildRecoverByAccountMaterial,
  newStateFromMaterial: kl.newStateFromMaterial,
}));

function state(keyEpoch: string): StateDto {
  return {
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1,
    keyEpoch, stateVersion: '1', changeSequence: '0',
    signPub: 'A', recoverSignPub: 'A',
    smpKdf: {} as never, recoveryKdf: {} as never,
    envelopeSmp: {} as never, envelopeRecovery: {} as never, envelopeAccountVersion: '1',
    recoveryCodeSetTime: null,
  } as StateDto;
}

describe('KeyLifecycleOps 失败路径密钥卫生（P4）', () => {
  it('destroySync：installNewEpoch 抛错时传入的 ownedDek 被清零', async () => {
    const liveDek = new Uint8Array(32).fill(5);
    kl.unlockDek.mockResolvedValue(new Uint8Array(32).fill(5));
    kl.newRecoveryCode.mockReturnValue({ code: 'NEW-CODE', raw: new Uint8Array(32).fill(1) });
    kl.createInitialMaterial.mockImplementation(async () => ({
      dek: new Uint8Array(32).fill(9),
      accountRecoveryKey: new Uint8Array(32).fill(2),
    }));
    kl.newStateFromMaterial.mockReturnValue({});

    let captured: Uint8Array | undefined;
    const deps = {
      userId: '1',
      client: {
        destroy: async () => ({ keyEpoch: '2', stateVersion: '1', changeSequence: '0' }),
      },
      stateStore: { getSnapshot: () => ({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' }) },
      isUnlocked: () => false,
      dek: () => liveDek,
      keyEpoch: () => '1',
      signSeed: () => new Uint8Array(64),
      pendingCleanup: () => undefined,
      getRemoteState: async () => state('1'),
      unlockFromState: vi.fn(async () => {}),
      installNewEpoch: vi.fn(async (_f: string | undefined, _s: SyncStateSnapshot, dek: Uint8Array) => {
        captured = dek;
        throw new Error('install boom');
      }),
      writePendingIntent: vi.fn(async () => {}),
    } as unknown as KeyLifecycleDeps;

    const ops = new KeyLifecycleOps(deps);
    await expect(ops.destroySync('smp')).rejects.toThrow('install boom');
    expect(captured).toBeDefined();
    expect([...captured!].every((b) => b === 0)).toBe(true);
  });
});