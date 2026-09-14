import { randomBytes } from 'crypto';
import { generateDek, deriveSyncSignKeyPair } from './crypto/keyStore';
import {
  generateRecoveryCode,
  deriveKekRecovery,
  deriveRecoverSignKeyPair,
  encodeBase64Url,
  type RecoveryKdfParams,
} from './crypto/recoveryCode';
import { hkdfSha256, SYNC_INFO } from './crypto/hkdf';
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
  envelopeAccount: EnvelopeDto;
  accountRecoveryKey: Uint8Array;
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

  const accountRecoveryKey = new Uint8Array(randomBytes(32));
  const kekAccount = hkdfSha256(accountRecoveryKey, new Uint8Array(0), SYNC_INFO.kekAccount);
  let envelopeAccount: EnvelopeDto;
  try {
    envelopeAccount = sealEnvelope(kekAccount, dek, userId, keyEpoch, 'account', '1');
  } finally {
    kekAccount.fill(0);
  }

  return { dek, signPub, recoverSignPub, smpKdf, recoveryKdf, envelopeSmp, envelopeRecovery, envelopeAccount, accountRecoveryKey };
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
    envelopeAccount: material.envelopeAccount,
    accountRecoveryKey: encodeBase64Url(material.accountRecoveryKey),
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

/**
 * 换 SMP 口令只重封 smp envelope（版本 +1），DEK 与账号恢复材料不变。
 */
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
  let envelopeSmp: EnvelopeDto;
  try {
    envelopeSmp = sealEnvelope(kekSmp, verifiedDek, userId, keyEpoch, 'smp', incU64(oldEnvelopeSmp.envelopeVersion));
  } finally {
    kekSmp.fill(0);
  }
  return { verifiedDek, smpKdf, envelopeSmp };
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

/** 账号恢复换钥材料：DEK 不变，重封 smp/recovery/account 三条 envelope（版本各 +1）。 */
export interface RecoverByAccountMaterial {
  smpKdf: SmpKdfDto;
  envelopeSmp: EnvelopeDto;
  recoveryKdf: RecoveryKdfDto;
  envelopeRecovery: EnvelopeDto;
  envelopeAccount: EnvelopeDto;
  accountRecoveryKey: Uint8Array;
  recoverSignPub: string;
  /** DEK 派生的 syncSign seed（签名 account-recover mutation）。 */
  signSeed: Uint8Array;
}

export async function buildRecoverByAccountMaterial(
  userId: string,
  keyEpoch: string,
  dek: Uint8Array,
  oldEnvelopeSmpVersion: string,
  oldEnvelopeRecoveryVersion: string,
  oldEnvelopeAccountVersion: string,
  newSmp: string,
  newRecoveryRaw: Uint8Array,
  newAccountRecoveryKey: Uint8Array,
): Promise<RecoverByAccountMaterial> {
  const smpKdf = newSmpKdf();
  const kekSmp = await deriveKekSmpInWorker(newSmp, smpKdfDtoToParams(smpKdf));
  let envelopeSmp: EnvelopeDto;
  try {
    envelopeSmp = sealEnvelope(kekSmp, dek, userId, keyEpoch, 'smp', incU64(oldEnvelopeSmpVersion));
  } finally {
    kekSmp.fill(0);
  }

  const recoveryKdf = newRecoveryKdf();
  const kekRecovery = deriveKekRecovery(newRecoveryRaw, recoveryKdfDtoToParams(recoveryKdf));
  let envelopeRecovery: EnvelopeDto;
  try {
    envelopeRecovery = sealEnvelope(kekRecovery, dek, userId, keyEpoch, 'recovery', incU64(oldEnvelopeRecoveryVersion));
  } finally {
    kekRecovery.fill(0);
  }

  const kekAccount = hkdfSha256(newAccountRecoveryKey, new Uint8Array(0), SYNC_INFO.kekAccount);
  let envelopeAccount: EnvelopeDto;
  try {
    envelopeAccount = sealEnvelope(kekAccount, dek, userId, keyEpoch, 'account', incU64(oldEnvelopeAccountVersion));
  } finally {
    kekAccount.fill(0);
  }

  return {
    smpKdf,
    envelopeSmp,
    recoveryKdf,
    envelopeRecovery,
    envelopeAccount,
    accountRecoveryKey: newAccountRecoveryKey,
    recoverSignPub: encodeBase64Url(deriveRecoverSignKeyPair(newRecoveryRaw).publicKey),
    signSeed: deriveSyncSignKeyPair(dek).seed,
  };
}
