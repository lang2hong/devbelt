import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { createInitialMaterial, unlockDek, newRecoveryCode } from '../../src/sync/keyLifecycle';
import { openEnvelope } from '../../src/sync/envelope';
import { deriveKekRecovery } from '../../src/sync/crypto/recoveryCode';
import { decodeBase64Url } from '../../src/sync/crypto/recoveryCode';

const workerBuilt = existsSync(join(__dirname, '../../out/argon2Worker.js'));
const itWorker = workerBuilt ? it : it.skip;

const userId = '7';
const keyEpoch = '1';
const recoveryRaw = new Uint8Array(32).fill(3);

describe('密钥生命周期', () => {
  itWorker('createInitialMaterial → unlockDek 用 SMP 重派生并解开 DEK（逐字节一致）', async () => {
    const material = await createInitialMaterial(userId, keyEpoch, 'smp-password', recoveryRaw);
    expect(material.dek).toHaveLength(32);
    expect(decodeBase64Url(material.signPub)).toHaveLength(32);
    expect(decodeBase64Url(material.recoverSignPub)).toHaveLength(32);
    expect(material.smpKdf.alg).toBe('argon2id');
    expect(material.recoveryKdf.alg).toBe('hkdf-sha256');

    // envelope_recovery 可用 KEK_recovery 解开，且明文即 dek
    const kekRecovery = deriveKekRecovery(recoveryRaw, {
      alg: 'hkdf-sha256', version: 1,
      salt: new Uint8Array(Buffer.from(material.recoveryKdf.salt, 'base64url')),
      outputBytes: 32,
    });
    expect(Buffer.from(openEnvelope(kekRecovery, material.envelopeRecovery, userId, keyEpoch, 'recovery')).toString('hex'))
      .toBe(Buffer.from(material.dek).toString('hex'));

    // unlockDek 走 Worker 派生 KEK_smp 再解 envelopeSmp
    const unlocked = await unlockDek(userId, keyEpoch, 'smp-password', material.smpKdf, material.envelopeSmp);
    expect(Buffer.from(unlocked).toString('hex')).toBe(Buffer.from(material.dek).toString('hex'));
  }, 60000);

  it('newRecoveryCode 返回 32B raw 与非空展示码', () => {
    const { code, raw } = newRecoveryCode();
    expect(raw).toHaveLength(32);
    expect(code.length).toBeGreaterThan(0);
  });
});