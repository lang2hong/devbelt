import { randomBytes } from 'crypto';
import { generateDek, deriveSyncSignKeyPair } from './crypto/keyStore';
import {
  generateRecoveryCode,
  deriveKekRecovery,
  deriveRecoverSignKeyPair,
  encodeBase64Url,
  type RecoveryKdfParams,
} from './crypto/recoveryCode';
import { deriveKekSmpInWorker } from './crypto/smpKdf';
import { sealEnvelope, openEnvelope } from './envelope';
import type { SmpKdfParams } from './crypto/smpKdfParams';
import type { EnvelopeDto, NewStateDto, RecoveryKdfDto, SmpKdfDto } from './e2e/types';

/**
 * 密钥生命周期（init 材料生成 / unlock DEK 恢复）。
 *
 * - init：生成 32B DEK、syncSign/recoverSign 密钥对、16B CSPRNG KDF salt，用 Argon2id(SMP)
 *   （Worker）派生 KEK_smp 包裹 DEK，用恢复码派生 KEK_recovery 包裹 DEK，产出 newState。
 * - unlock：用 SMP + 服务端下发的 smpKdf 重派生 KEK_smp（Worker），解开 envelopeSmp 得到 DEK。
 * 恢复码只由 init 调用方一次性展示，本层只接收 raw、不落盘、不写日志。
 */

export interface InitialSyncMaterial {
  dek: Uint8Array;
  signPub: string;
  recoverSignPub: string;
  smpKdf: SmpKdfDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeSmp: EnvelopeDto;
  envelopeRecovery: EnvelopeDto;
}

export function newRecoveryCode(): { code: string; raw: Uint8Array } {
  return generateRecoveryCode();
}

function smpKdfDtoToParams(dto: SmpKdfDto): SmpKdfParams {
  return {
    alg: dto.alg,
    version: dto.version,
    memoryKiB: dto.memoryKiB,
    iterations: dto.iterations,
    parallelism: dto.parallelism,
    salt: new Uint8Array(Buffer.from(dto.salt, 'base64url')),
    outputBytes: dto.outputBytes,
  };
}

function newSmpKdf(memoryKiB = 65536, iterations = 3, parallelism = 1): SmpKdfDto {
  return {
    alg: 'argon2id',
    version: 1,
    memoryKiB,
    iterations,
    parallelism,
    salt: encodeBase64Url(new Uint8Array(randomBytes(16))),
    outputBytes: 32,
  };
}

function newRecoveryKdf(): RecoveryKdfDto {
  return {
    alg: 'hkdf-sha256',
    version: 1,
    salt: encodeBase64Url(new Uint8Array(randomBytes(16))),
    outputBytes: 32,
  };
}

export async function createInitialMaterial(
  userId: string,
  keyEpoch: string,
  smp: string,
  recoveryRaw: Uint8Array,
): Promise<InitialSyncMaterial> {
  const dek = generateDek();
  const signPub = encodeBase64Url(deriveSyncSignKeyPair(dek).publicKey);
  const recoverSignPub = encodeBase64Url(deriveRecoverSignKeyPair(recoveryRaw).publicKey);

  const smpKdf = newSmpKdf();
  const kekSmp = await deriveKekSmpInWorker(smp, smpKdfDtoToParams(smpKdf));
  const envelopeSmp = sealEnvelope(kekSmp, dek, userId, keyEpoch, 'smp', '1');

  const recoveryKdf = newRecoveryKdf();
  const kekRecovery = deriveKekRecovery(recoveryRaw, {
    alg: 'hkdf-sha256',
    version: 1,
    salt: new Uint8Array(Buffer.from(recoveryKdf.salt, 'base64url')),
    outputBytes: 32,
  });
  const envelopeRecovery = sealEnvelope(kekRecovery, dek, userId, keyEpoch, 'recovery', '1');

  return { dek, signPub, recoverSignPub, smpKdf, recoveryKdf, envelopeSmp, envelopeRecovery };
}

export async function unlockDek(
  userId: string,
  keyEpoch: string,
  smp: string,
  smpKdf: SmpKdfDto,
  envelopeSmp: EnvelopeDto,
): Promise<Uint8Array> {
  const kekSmp = await deriveKekSmpInWorker(smp, smpKdfDtoToParams(smpKdf));
  return openEnvelope(kekSmp, envelopeSmp, userId, keyEpoch, 'smp');
}

function incU64(v: string): string {
  return (BigInt(v) + 1n).toString();
}

function recoveryKdfDtoToParams(dto: RecoveryKdfDto): RecoveryKdfParams {
  return {
    alg: dto.alg,
    version: dto.version,
    salt: new Uint8Array(Buffer.from(dto.salt, 'base64url')),
    outputBytes: dto.outputBytes,
  };
}

/** 由 init/destroy/reset 材料组装 newState DTO（协议字段 + 双 envelope + 双公钥）。 */
export function newStateFromMaterial(material: InitialSyncMaterial): NewStateDto {
  return {
    protocolVersion: 1,
    cipherSuite: 'AES-256-GCM',
    formatVersion: 1,
    smpKdf: material.smpKdf,
    recoveryKdf: material.recoveryKdf,
    envelopeSmp: material.envelopeSmp,
    envelopeRecovery: material.envelopeRecovery,
    signPub: material.signPub,
    recoverSignPub: material.recoverSignPub,
  };
}

/** 换钥材料：验证旧 SMP（解封当前 envelopeSmp 得 DEK），用新 SMP 重封 smp envelope（版本 +1）。 */
export interface ChangeKeyMaterial {
  /** 解封得到的 DEK（临时，调用方比对后清零）。 */
  verifiedDek: Uint8Array;
  smpKdf: SmpKdfDto;
  envelopeSmp: EnvelopeDto;
}

export async function buildChangeKeyMaterial(
  userId: string,
  keyEpoch: string,
  oldSmp: string,
  oldSmpKdf: SmpKdfDto,
  oldEnvelopeSmp: EnvelopeDto,
  newSmp: string,
): Promise<ChangeKeyMaterial> {
  const verifiedDek = await unlockDek(userId, keyEpoch, oldSmp, oldSmpKdf, oldEnvelopeSmp);
  const smpKdf = newSmpKdf();
  const kekSmp = await deriveKekSmpInWorker(newSmp, smpKdfDtoToParams(smpKdf));
  try {
    const envelopeSmp = sealEnvelope(kekSmp, verifiedDek, userId, keyEpoch, 'smp', incU64(oldEnvelopeSmp.envelopeVersion));
    return { verifiedDek, smpKdf, envelopeSmp };
  } finally {
    kekSmp.fill(0);
  }
}

/** 恢复码恢复材料：旧恢复码解封 DEK + 派生旧 recoverSign seed；新 SMP/新恢复码重封两条 envelope（各 +1 版本）。 */
export interface RecoverMaterial {
  /** 解封得到的 DEK（临时，调用方清零）。 */
  dek: Uint8Array;
  /** 旧恢复码派生的 recoverSign seed（签名 state.recover，调用方签名后清零）。 */
  oldRecoverSignSeed: Uint8Array;
  smpKdf: SmpKdfDto;
  envelopeSmp: EnvelopeDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeRecovery: EnvelopeDto;
  recoverSignPub: string;
}

export async function buildRecoverMaterial(
  userId: string,
  keyEpoch: string,
  oldRecoveryRaw: Uint8Array,
  oldRecoveryKdf: RecoveryKdfDto,
  oldEnvelopeRecovery: EnvelopeDto,
  oldEnvelopeSmpVersion: string,
  newSmp: string,
  newRecoveryRaw: Uint8Array,
): Promise<RecoverMaterial> {
  const kekRecovery = deriveKekRecovery(oldRecoveryRaw, recoveryKdfDtoToParams(oldRecoveryKdf));
  let dek: Uint8Array;
  try {
    dek = openEnvelope(kekRecovery, oldEnvelopeRecovery, userId, keyEpoch, 'recovery');
  } finally {
    kekRecovery.fill(0);
  }
  const oldRecoverSignSeed = deriveRecoverSignKeyPair(oldRecoveryRaw).seed;

  const smpKdf = newSmpKdf();
  const kekSmp = await deriveKekSmpInWorker(newSmp, smpKdfDtoToParams(smpKdf));
  let envelopeSmp: EnvelopeDto;
  try {
    envelopeSmp = sealEnvelope(kekSmp, dek, userId, keyEpoch, 'smp', incU64(oldEnvelopeSmpVersion));
  } finally {
    kekSmp.fill(0);
  }

  const recoveryKdf = newRecoveryKdf();
  const kekRecoveryNew = deriveKekRecovery(newRecoveryRaw, recoveryKdfDtoToParams(recoveryKdf));
  let envelopeRecovery: EnvelopeDto;
  try {
    envelopeRecovery = sealEnvelope(kekRecoveryNew, dek, userId, keyEpoch, 'recovery', incU64(oldEnvelopeRecovery.envelopeVersion));
  } finally {
    kekRecoveryNew.fill(0);
  }

  const recoverSignPub = encodeBase64Url(deriveRecoverSignKeyPair(newRecoveryRaw).publicKey);
  return { dek, oldRecoverSignSeed, smpKdf, envelopeSmp, recoveryKdf, envelopeRecovery, recoverSignPub };
}