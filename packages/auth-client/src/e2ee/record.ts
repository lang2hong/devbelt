import { jcs } from '@devbelt/db-host/sync/crypto/jcs';
import { aesGcmOpen, b64urlDecode } from './webcrypto';

/** 服务端密文 feed 的 record 形状（与 RecordDto 对称）。 */
export interface CipherRecord {
  recordId: string;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
  version: string;
  changeSequence: string;
  deleteTime?: string | null;
}

function recordAadBytes(userId: string, keyEpoch: string, recordId: string, recordVersion: string): Uint8Array {
  const aad = {
    userId, keyEpoch, recordId, recordVersion,
    protocolVersion: 1, cipherSuite: 'AES-256-GCM', formatVersion: 1, purpose: 'record',
  };
  return new TextEncoder().encode(jcs(aad));
}

/** 本地解密一条 record（WebCrypto AES-256-GCM + record AAD，与服务端/扩展同构）；墓碑返回 undefined。 */
export async function openCipherRecord(
  dek: Uint8Array,
  rec: CipherRecord,
  ctx: { userId: string; keyEpoch: string },
): Promise<unknown> {
  if (rec.deleteTime) return undefined;
  if (!rec.nonce || !rec.ciphertext || !rec.tag) throw new Error('record ciphertext incomplete');
  const plaintext = await aesGcmOpen(
    dek,
    b64urlDecode(rec.nonce),
    b64urlDecode(rec.ciphertext),
    b64urlDecode(rec.tag),
    recordAadBytes(ctx.userId, ctx.keyEpoch, rec.recordId, rec.version),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
