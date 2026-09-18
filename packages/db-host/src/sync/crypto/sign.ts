import { jcs } from './jcs.js';
import { signEd25519 } from './ed25519.js';

/**
 * 签名构造（§7.4）。action 字段集与服务端 `assertSignature` 口径逐一对齐：
 *  - record 签名含 recordId + baseVersion
 *  - state 签名含 expectedStateVersion
 * recover 使用恢复码派生的 seed，其余操作使用 DEK 派生的 syncSign seed。
 */

export const SYNC_DOMAIN = 'devbelt/sync/v1';

export type SyncAction = 'record.put' | 'record.delete' | 'state.change-key' | 'state.recover' | 'state.recover-by-account' | 'state.destroy';

export interface SigningCommon {
  userId: string; // 十进制字符串
  keyEpoch: string; // 十进制字符串，无前导零
  mutationId: string; // Base64Url22（16 raw bytes）
  requestDigest: string; // Base64Url43（32 raw bytes）
}

export interface RecordSigningFields extends SigningCommon {
  recordId: string;
  baseVersion: string; // 十进制字符串
}

export interface StateSigningFields extends SigningCommon {
  expectedStateVersion: string; // 十进制字符串
}

export type SigningInput =
  | ({ domain: typeof SYNC_DOMAIN; action: 'record.put' | 'record.delete' } & RecordSigningFields)
  | ({ domain: typeof SYNC_DOMAIN; action: 'state.change-key' | 'state.recover' | 'state.recover-by-account' | 'state.destroy' } & StateSigningFields);

export function buildRecordSigningInput(action: 'record.put' | 'record.delete', f: RecordSigningFields): SigningInput {
  return { domain: SYNC_DOMAIN, action, userId: f.userId, keyEpoch: f.keyEpoch, recordId: f.recordId, baseVersion: f.baseVersion, mutationId: f.mutationId, requestDigest: f.requestDigest };
}

export function buildStateSigningInput(action: 'state.change-key' | 'state.recover' | 'state.recover-by-account' | 'state.destroy', f: StateSigningFields): SigningInput {
  return { domain: SYNC_DOMAIN, action, userId: f.userId, keyEpoch: f.keyEpoch, expectedStateVersion: f.expectedStateVersion, mutationId: f.mutationId, requestDigest: f.requestDigest };
}

/** 签名 = Ed25519.sign(UTF8(JCS(signingInput)))，返回 64B base64url 无 padding。 */
export function signSigningInput(input: SigningInput, seed: Uint8Array): string {
  const message = Buffer.from(jcs(input), 'utf8');
  return Buffer.from(signEd25519(message, seed)).toString('base64url');
}
