import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'crypto';
import { parseU64, isU64, incU64, U64_MAX } from '../../src/domain/syncU64.js';
import { jcs, requestDigestOf, verifyEd25519, decodeB64Url, decodeB64UrlRange, sha256 } from '../../src/service/syncCrypto.js';
import { JCS_VECTORS, NORMALIZED_JCS_VECTORS, INVALID_JCS_VALUES } from '@db-client/core/testing';
import { SYNC_SIGN_TEST_VECTOR } from '@db-client/core/testing';

describe('syncU64', () => {
  it('parses and rejects boundaries correctly', () => {
    expect(parseU64('0')).toBe(0n);
    expect(parseU64('18446744073709551615')).toBe(U64_MAX);
    expect(isU64('1')).toBe(true);
    expect(isU64('')).toBe(false);
    expect(isU64('01')).toBe(false);       // 前导零
    expect(isU64('-1')).toBe(false);
    expect(isU64('1.5')).toBe(false);
    expect(isU64('18446744073709551616')).toBe(false); // > 2^64-1
    expect(isU64('abc')).toBe(false);
  });

  it('increments without precision loss', () => {
    expect(incU64('18446744073709551614')).toBe('18446744073709551615');
    expect(incU64('0')).toBe('1');
  });

  it('incU64 rejects overflow at max', () => {
    expect(() => incU64('18446744073709551615')).toThrow();
  });
});

describe('syncCrypto', () => {
  it('jcs sorts keys and is byte-stable', () => {
    expect(jcs({ b: 1, a: 'x', c: { d: true, e: null } })).toBe('{"a":"x","b":1,"c":{"d":true,"e":null}}');
    expect(jcs([3, 1, 2])).toBe('[3,1,2]');
    expect(jcs('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it.each(JCS_VECTORS)('jcs 共享向量 $name（与扩展端双向锚定）', ({ value, expected }) => {
    expect(jcs(value)).toBe(expected);
  });

  it.each(NORMALIZED_JCS_VECTORS)('jcs 共享向量 $name（域外归一一致）', ({ value, expected }) => {
    expect(jcs(value)).toBe(expected);
  });

  it.each(INVALID_JCS_VALUES)('jcs 共享向量 $name（非有限拒绝一致）', ({ value }) => {
    expect(() => jcs(value)).toThrow();
  });

  it('requestDigestOf is base64url 43 chars', () => {
    const d = requestDigestOf({ a: 1 });
    expect(d).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('decodeB64Url enforces exact byte length', () => {
    expect(decodeB64Url(Buffer.alloc(16, 7).toString('base64url'), 16, 'x')).toHaveLength(16);
    expect(() => decodeB64Url('AA', 16, 'x')).toThrow();
  });

  it('decodeB64UrlRange enforces [min,max] byte range', () => {
    expect(decodeB64UrlRange(Buffer.alloc(1, 7).toString('base64url'), 1, 256 * 1024, 'x')).toHaveLength(1);
    expect(decodeB64UrlRange(Buffer.alloc(256 * 1024, 7).toString('base64url'), 1, 256 * 1024, 'x')).toHaveLength(256 * 1024);
    expect(() => decodeB64UrlRange('', 1, 256 * 1024, 'x')).toThrow(/not base64url/);
    expect(() => decodeB64UrlRange(Buffer.alloc(256 * 1024 + 1, 7).toString('base64url'), 1, 256 * 1024, 'x')).toThrow(/decode/);
  });

  it('verifies a real Ed25519 signature against a raw public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawPub = Buffer.from((publicKey.export({ format: 'jwk' }) as any).x as string, 'base64url');
    const msg = Buffer.from('hello', 'utf8');
    const sig = nodeSign(null, msg, privateKey);
    expect(verifyEd25519(rawPub, msg, sig)).toBe(true);
    expect(verifyEd25519(rawPub, Buffer.from('tampered'), sig)).toBe(false);

    const badRaw = Buffer.alloc(32, 1);
    expect(verifyEd25519(badRaw, msg, sig)).toBe(false);
  });

  it('互通向量（单一源）：Node verify 验 @noble 签名，篡改失败', () => {
    const rawPub = Buffer.from(SYNC_SIGN_TEST_VECTOR.publicKeyHex, 'hex');
    const msg = Buffer.from(SYNC_SIGN_TEST_VECTOR.message, 'utf8');
    const sig = Buffer.from(SYNC_SIGN_TEST_VECTOR.signatureB64Url, 'base64url');
    expect(verifyEd25519(rawPub, msg, sig)).toBe(true);
    expect(verifyEd25519(rawPub, Buffer.concat([msg, Buffer.from('x')]), sig)).toBe(false);
  });

  it('sha256 matches digest of requestDigestOf', () => {
    const digest = sha256(Buffer.from('payload', 'utf8'));
    expect(digest).toHaveLength(32);
    expect(digest.toString('base64url')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
describe('base64url canonicality (aliasing must be rejected)', () => {
  it('rejects non-canonical encodings that decode to the same bytes', () => {
    // "AA" 与 "AB" 都解码成单字节 <00>：Buffer 静默丢弃末字符多余低位。
    // 若放行，recordId 就能以多个各自合法签名的身份指向同一条物理记录，
    // mutationId 也会别名折叠到同一主键却带不同 digest（诚实重试被判 409）。
    expect(Buffer.from('AA', 'base64url').equals(Buffer.from('AB', 'base64url'))).toBe(true);
    expect(() => decodeB64Url('AA', 1, 'x')).not.toThrow();
    expect(() => decodeB64Url('AB', 1, 'x')).toThrow(/canonical/);
  });

  it('rejects padding, out-of-alphabet chars and impossible lengths', () => {
    const canonical16 = Buffer.alloc(16, 7).toString('base64url');
    expect(() => decodeB64Url(canonical16, 16, 'mutationId')).not.toThrow();

    expect(() => decodeB64Url(`${canonical16}=`, 16, 'mutationId')).toThrow(/unpadded/);
    // 标准 base64 的 +/ 不属于 base64url 字母表
    expect(() => decodeB64Url('a+/b', 3, 'x')).toThrow(/unpadded base64url/);
    // 无 padding base64 不可能出现 %4===1 的长度
    expect(() => decodeB64Url('AAAAA', 3, 'x')).toThrow(/invalid base64url length/);
    expect(() => decodeB64Url('', 1, 'x')).toThrow();
  });

  it('still accepts every canonical round-trip', () => {
    for (const n of [1, 12, 16, 32, 64]) {
      const s = Buffer.alloc(n, n).toString('base64url');
      expect(decodeB64Url(s, n, 'x').length).toBe(n);
    }
  });

  it('applies the same canonicality rule to the range variant', () => {
    expect(() => decodeB64UrlRange('AB', 1, 10, 'ciphertext')).toThrow(/canonical/);
    expect(decodeB64UrlRange(Buffer.alloc(5, 1).toString('base64url'), 1, 10, 'ciphertext').length).toBe(5);
  });
});
