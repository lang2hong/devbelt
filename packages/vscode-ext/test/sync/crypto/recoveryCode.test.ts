import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_BYTES,
  RECOVERY_KDF_SALT_BYTES,
  assertRecoveryKdfParams,
  decodeBase64Url,
  deriveKekRecovery,
  deriveRecoverSignKeyPair,
  encodeBase64Url,
  formatRecoveryCode,
  generateRecoveryCode,
  type RecoveryKdfParams,
} from '../../../src/sync/crypto/recoveryCode';

describe('recoveryCode', () => {
  it('生成 32B 恢复码 + Base64Url 无 padding', () => {
    const { code, raw } = generateRecoveryCode();
    expect(raw.length).toBe(RECOVERY_CODE_BYTES);
    expect(code).not.toMatch(/[+/=]/);
    expect(Buffer.from(decodeBase64Url(code)).toString('hex')).toBe(Buffer.from(raw).toString('hex'));
  });

  it('Base64Url 编解码 roundtrip', () => {
    const bytes = new Uint8Array(32).fill(0xab);
    const enc = encodeBase64Url(bytes);
    expect(enc).not.toContain('/');
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('=');
    expect(decodeBase64Url(enc)).toEqual(bytes);
  });

  it('formatRecoveryCode 分组展示', () => {
    expect(formatRecoveryCode('abcdABCDabcd')).toBe('abcd ABCD abcd');
  });

  it('deriveKekRecovery 32B 且 salt 影响结果', () => {
    const raw = new Uint8Array(RECOVERY_CODE_BYTES).fill(5);
    const k1 = deriveKekRecovery(raw, new Uint8Array(RECOVERY_KDF_SALT_BYTES).fill(1));
    const k2 = deriveKekRecovery(raw, new Uint8Array(RECOVERY_KDF_SALT_BYTES).fill(2));
    expect(k1.length).toBe(32);
    expect(Buffer.from(k1).toString('hex')).not.toBe(Buffer.from(k2).toString('hex'));
  });

  it('deriveRecoverSignKeyPair 派生 32B seed + 32B 公钥', () => {
    const raw = new Uint8Array(RECOVERY_CODE_BYTES).fill(9);
    const kp = deriveRecoverSignKeyPair(raw);
    expect(kp.seed.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('KDF 参数边界', () => {
    const valid: RecoveryKdfParams = { alg: 'hkdf-sha256', version: 1, salt: new Uint8Array(16), outputBytes: 32 };
    expect(() => assertRecoveryKdfParams(valid)).not.toThrow();
    expect(() => assertRecoveryKdfParams({ ...valid, alg: 'argon2id' } as unknown as RecoveryKdfParams)).toThrowError(/alg/);
    expect(() => assertRecoveryKdfParams({ ...valid, salt: new Uint8Array(15) } as unknown as RecoveryKdfParams)).toThrowError(/salt/);
  });
});