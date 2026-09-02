import { describe, expect, it } from 'vitest';
import {
  U64_MAX,
  assertBase64UrlNoPad,
  assertRecordId,
  assertU64Decimal,
  validateNewState,
} from '../../../src/sync/e2e/types';

const smpKdf = { alg: 'argon2id' as const, version: 1 as const, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'A'.repeat(22), outputBytes: 32 as const };
const recoveryKdf = { alg: 'hkdf-sha256' as const, version: 1 as const, salt: 'A'.repeat(22), outputBytes: 32 as const };
const envelope = { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) };
const newState = { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, smpKdf, recoveryKdf, envelopeSmp: envelope, envelopeRecovery: envelope, signPub: 'A'.repeat(43), recoverSignPub: 'A'.repeat(43) };

describe('assertU64Decimal', () => {
  it('通过边界 0(allowZero)/1/U64_MAX', () => {
    expect(assertU64Decimal('0', 'x', true)).toBe('0');
    expect(assertU64Decimal('1', 'x')).toBe('1');
    expect(assertU64Decimal(U64_MAX, 'x')).toBe(U64_MAX);
  });

  it('拒绝超 u64', () => {
    expect(() => assertU64Decimal('18446744073709551616', 'x')).toThrowError(/u64/);
    expect(() => assertU64Decimal('99999999999999999999999999', 'x')).toThrowError(/u64/);
  });

  it('拒绝前导零 / 负 / 非整数', () => {
    expect(() => assertU64Decimal('01', 'x')).toThrow();
    expect(() => assertU64Decimal('-1', 'x')).toThrow();
    expect(() => assertU64Decimal('1.5', 'x')).toThrow();
  });
});

describe('assertBase64UrlNoPad', () => {
  it('拒绝 padding（=）', () => {
    expect(() => assertBase64UrlNoPad(`${'A'.repeat(22)}=`, 16, 'x')).toThrowError(/unpadded base64url/);
  });

  it('拒绝 + / / 空', () => {
    expect(() => assertBase64UrlNoPad('+/==', 16, 'x')).toThrow(/unpadded base64url/);
    expect(() => assertBase64UrlNoPad('', 16, 'x')).toThrow(/unpadded base64url/);
  });

  it('解码长度不符拒绝', () => {
    expect(() => assertBase64UrlNoPad('A'.repeat(22), 32, 'x')).toThrowError(/decode/);
  });
});

describe('assertRecordId', () => {
  it('接受 1..128B base64url 无 padding', () => {
    expect(assertRecordId('A'.repeat(22))).toBe('A'.repeat(22));
  });

  it('拒绝 padding / 空 / 超长', () => {
    expect(() => assertRecordId('')).toThrow();
    expect(() => assertRecordId(`${'A'.repeat(22)}=`)).toThrow(/unpadded base64url/);
  });
});

describe('validateNewState 嵌套校验', () => {
  it('合法 newState 通过', () => {
    expect(validateNewState(newState)).toEqual(newState);
  });

  it('拒绝 smpKdf memory 越界', () => {
    expect(() => validateNewState({ ...newState, smpKdf: { ...smpKdf, memoryKiB: 1024 } })).toThrowError(/memoryKiB/);
  });

  it('拒绝 smpKdf salt 非 16B', () => {
    expect(() => validateNewState({ ...newState, smpKdf: { ...smpKdf, salt: 'A'.repeat(10) } })).toThrowError(/salt/);
  });

  it('拒绝 envelope 协议常量错误', () => {
    expect(() => validateNewState({ ...newState, envelopeSmp: { ...envelope, cipherSuite: 'AES-128-GCM' as never } })).toThrowError(/cipher/);
  });

  it('拒绝额外字段', () => {
    expect(() => validateNewState({ ...newState, extra: 1 })).toThrowError(/unexpected/);
  });
});
