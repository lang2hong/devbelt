import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  createInitialMaterial,
  unlockDek,
  newRecoveryCode,
  buildChangeKeyMaterial,
  buildRecoverMaterial,
  buildRecoverByAccountMaterial,
  newStateFromMaterial,
  type InitialSyncMaterial,
} from '@devkit/db-host/sync/keyLifecycle';
import { openEnvelope } from '@devkit/db-host/sync/envelope';
import { deriveKekRecovery } from '@devkit/db-host/sync/crypto/recoveryCode';
import { decodeBase64Url } from '@devkit/db-host/sync/crypto/recoveryCode';
import { hkdfSha256, SYNC_INFO } from '@devkit/db-host/sync/crypto/hkdf';

const workerBuilt = existsSync(join(__dirname, '../../out/argon2Worker.js'));
const itWorker = workerBuilt ? it : it.skip;

const userId = '7';
const keyEpoch = '1';
const recoveryRaw = new Uint8Array(32).fill(3);
const b64 = (bytes: number) => 'A'.repeat(Math.ceil((bytes * 4) / 3));

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

describe('B5 生命周期材料', () => {
  itWorker('buildChangeKeyMaterial：旧 SMP 验证一致、envelope 版本 +1、DEK 不变、新 SMP 可解锁', async () => {
    const material = await createInitialMaterial(userId, keyEpoch, 'old-smp', recoveryRaw);
    const cm = await buildChangeKeyMaterial(userId, keyEpoch, 'old-smp', material.smpKdf, material.envelopeSmp, 'new-smp');
    expect(cm.envelopeSmp.envelopeVersion).toBe('2');
    expect(Buffer.from(cm.verifiedDek).toString('hex')).toBe(Buffer.from(material.dek).toString('hex'));

    const dek2 = await unlockDek(userId, keyEpoch, 'new-smp', cm.smpKdf, cm.envelopeSmp);
    expect(Buffer.from(dek2).toString('hex')).toBe(Buffer.from(material.dek).toString('hex'));
    // 旧 SMP 无法解新 envelope（GCM tag 失败）
    await expect(unlockDek(userId, keyEpoch, 'old-smp', cm.smpKdf, cm.envelopeSmp)).rejects.toThrow();
  }, 60000);

  itWorker('buildRecoverMaterial：旧恢复码解封 DEK，两条 envelope 版本 +1，新恢复码轮换', async () => {
    const material = await createInitialMaterial(userId, keyEpoch, 'smp-password', recoveryRaw);
    const newRecovery = newRecoveryCode();
    const rm = await buildRecoverMaterial(
      userId, keyEpoch, recoveryRaw, material.recoveryKdf, material.envelopeRecovery,
      material.envelopeSmp.envelopeVersion, 'new-smp', newRecovery.raw,
    );
    expect(Buffer.from(rm.dek).toString('hex')).toBe(Buffer.from(material.dek).toString('hex'));
    expect(rm.envelopeSmp.envelopeVersion).toBe('2');
    expect(rm.envelopeRecovery.envelopeVersion).toBe('2');
    expect(rm.recoverSignPub).not.toBe(material.recoverSignPub);

    // 新恢复码可解新 envelopeRecovery 得同一 DEK；旧恢复码不可
    const kekNew = deriveKekRecovery(newRecovery.raw, {
      alg: 'hkdf-sha256', version: 1,
      salt: new Uint8Array(Buffer.from(rm.recoveryKdf.salt, 'base64url')), outputBytes: 32,
    });
    expect(Buffer.from(openEnvelope(kekNew, rm.envelopeRecovery, userId, keyEpoch, 'recovery')).toString('hex'))
      .toBe(Buffer.from(material.dek).toString('hex'));
    const kekOld = deriveKekRecovery(recoveryRaw, {
      alg: 'hkdf-sha256', version: 1,
      salt: new Uint8Array(Buffer.from(rm.recoveryKdf.salt, 'base64url')), outputBytes: 32,
    });
    expect(() => openEnvelope(kekOld, rm.envelopeRecovery, userId, keyEpoch, 'recovery')).toThrow();
  }, 60000);

  it('newStateFromMaterial 组装完整 NewStateDto', () => {
    const material: InitialSyncMaterial = {
      dek: new Uint8Array(32),
      signPub: b64(32),
      recoverSignPub: b64(32),
      smpKdf: { alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: b64(16), outputBytes: 32 },
      recoveryKdf: { alg: 'hkdf-sha256', version: 1, salt: b64(16), outputBytes: 32 },
      envelopeSmp: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: b64(12), ciphertext: b64(32), tag: b64(16) },
      envelopeRecovery: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: b64(12), ciphertext: b64(32), tag: b64(16) },
      envelopeAccount: { protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, envelopeVersion: '1', nonce: b64(12), ciphertext: b64(32), tag: b64(16) },
      accountRecoveryKey: new Uint8Array(32),
    };
    const ns = newStateFromMaterial(material);
    expect(ns.signPub).toBe(material.signPub);
    expect(ns.recoverSignPub).toBe(material.recoverSignPub);
    expect(ns.smpKdf).toBe(material.smpKdf);
    expect(ns.recoveryKdf).toBe(material.recoveryKdf);
    expect(ns.envelopeSmp).toBe(material.envelopeSmp);
    expect(ns.envelopeRecovery).toBe(material.envelopeRecovery);
    expect(ns.protocolVersion).toBe(1);
    expect(ns.cipherSuite).toBe('AES-256-GCM');
  });

  itWorker('buildRecoverByAccountMaterial：DEK 不变、三条 envelope 版本 +1、新账号钥匙可解', async () => {
    const material = await createInitialMaterial(userId, keyEpoch, 'smp-password', recoveryRaw);
    const newRecovery = newRecoveryCode();
    const newAccountRaw = new Uint8Array(32).fill(9);
    const rm = await buildRecoverByAccountMaterial(
      userId, keyEpoch, material.dek,
      material.envelopeSmp.envelopeVersion, material.envelopeRecovery.envelopeVersion, material.envelopeAccount.envelopeVersion,
      'new-smp', newRecovery.raw, newAccountRaw,
    );
    expect(rm.envelopeSmp.envelopeVersion).toBe('2');
    expect(rm.envelopeRecovery.envelopeVersion).toBe('2');
    expect(rm.envelopeAccount.envelopeVersion).toBe('2');
    expect(rm.recoverSignPub).not.toBe(material.recoverSignPub);

    const kekAccount = hkdfSha256(newAccountRaw, new Uint8Array(0), SYNC_INFO.kekAccount);
    expect(Buffer.from(openEnvelope(kekAccount, rm.envelopeAccount, userId, keyEpoch, 'account')).toString('hex'))
      .toBe(Buffer.from(material.dek).toString('hex'));
  }, 60000);
});
