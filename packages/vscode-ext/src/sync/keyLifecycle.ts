import { randomBytes } from 'crypto';
import { generateDek, deriveSyncSignKeyPair } from './crypto/keyStore';
import { generateRecoveryCode, deriveKekRecovery, deriveRecoverSignKeyPair, encodeBase64Url } from './crypto/recoveryCode';
import { deriveKekSmpInWorker } from './crypto/smpKdf';
import { sealEnvelope, openEnvelope } from './envelope';
import type { SmpKdfParams } from './crypto/smpKdfParams';
import type { EnvelopeDto, RecoveryKdfDto, SmpKdfDto } from './e2e/types';

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