import { deriveKekSmp } from '@devbelt/db-host/sync/crypto/argon2';
import { jcs } from '@devbelt/db-host/sync/crypto/jcs';
import { assertSmpKdfParams, type SmpKdfParams } from '@devbelt/db-host/sync/crypto/smpKdfParams';
import { hkdfSha256, aesGcmOpen, b64urlDecode } from './webcrypto';
import type { EnvelopeDto } from '@devbelt/db-host/sync/e2e/types';

/**
 * 浏览器侧解锁（P6-S5b）：SMP → Argon2id(KEK_smp) → 解 envelopeSmp → DEK。
 *
 * Argon2id 必须由宿主注入的 `deriveKek` 执行（db-ui 在 **Web Worker** 内调
 * `deriveKekSmp`）；默认实现仅用于测试/Node。AES-GCM/HKDF 用 WebCrypto，与扩展
 * Node 实现逐字节对齐（相同 `smpKdf` 参数、相同 envelope info/AAD）。
 */
export interface SmpKdfDto {
  alg: string;
  version: number;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string; // base64url
  outputBytes: number;
}

export type DeriveKek = (smp: string, params: SmpKdfParams) => Promise<Uint8Array>;

export function smpKdfDtoToParams(dto: SmpKdfDto): SmpKdfParams {
  const params: SmpKdfParams = {
    alg: 'argon2id',
    version: 1,
    memoryKiB: dto.memoryKiB,
    iterations: dto.iterations,
    parallelism: dto.parallelism,
    salt: b64urlDecode(dto.salt), // 长度由 assertSmpKdfParams 校验（16B）
    outputBytes: 32,
  };
  assertSmpKdfParams(params);
  return params;
}

function envelopeInfo(keyEpoch: string, purpose: 'smp' | 'recovery' | 'account', envelopeVersion: string): string {
  return `devbelt/sync/v1/envelope/${BigInt(keyEpoch).toString(10)}/${purpose}/${BigInt(envelopeVersion).toString(10)}`;
}

function envelopeAadBytes(userId: string, keyEpoch: string, envelopeVersion: string, purpose: 'smp'): Uint8Array {
  const aad = { userId, keyEpoch, envelopeVersion, protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, purpose };
  return new TextEncoder().encode(jcs(aad));
}

/** 解锁得到 DEK（32B）。失败 fail-closed 抛错，不返回弱/空密钥。 */
export async function unlockDekBrowser(
  userId: string,
  keyEpoch: string,
  smp: string,
  smpKdf: SmpKdfDto,
  envelopeSmp: EnvelopeDto,
  deriveKek: DeriveKek = deriveKekSmp,
): Promise<Uint8Array> {
  const kek = await deriveKek(smp, smpKdfDtoToParams(smpKdf));
  try {
    const key = await hkdfSha256(kek, new Uint8Array(0), envelopeInfo(keyEpoch, 'smp', envelopeSmp.envelopeVersion), 32);
    const dek = await aesGcmOpen(
      key,
      b64urlDecode(envelopeSmp.nonce),
      b64urlDecode(envelopeSmp.ciphertext),
      b64urlDecode(envelopeSmp.tag),
      envelopeAadBytes(userId, keyEpoch, envelopeSmp.envelopeVersion, 'smp'),
    );
    if (dek.length !== 32) throw new Error('decrypted DEK has invalid length');
    return dek;
  } finally {
    kek.fill(0);
  }
}
