import { describe, expect, it } from 'vitest';
import {
  U64_MAX,
  assertBase64UrlNoPad,
  assertBase64UrlRange,
  assertRecordId,
  assertU64Decimal,
  validateAccountRecoveryMaterial,
  validateNewState,
  validateSyncState,
} from '@devbelt/db-host/sync/e2e/types';

const smpKdf = { alg: 'argon2id' as const, version: 1 as const, memoryKiB: 65536, iterations: 3, parallelism: 1, salt: 'A'.repeat(22), outputBytes: 32 as const };
const recoveryKdf = { alg: 'hkdf-sha256' as const, version: 1 as const, salt: 'A'.repeat(22), outputBytes: 32 as const };
const envelope = { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, envelopeVersion: '1', nonce: 'A'.repeat(16), ciphertext: 'A'.repeat(43), tag: 'A'.repeat(22) };
const newState = { protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const, smpKdf, recoveryKdf, envelopeSmp: envelope, envelopeRecovery: envelope, envelopeAccount: envelope, accountRecoveryKey: 'A'.repeat(43), signPub: 'A'.repeat(43), recoverSignPub: 'A'.repeat(43) };

const state = {
  protocolVersion: 1 as const, cipherSuite: 'AES-256-GCM' as const, formatVersion: 1 as const,
  keyEpoch: '1', stateVersion: '1', changeSequence: '0',
  signPub: 'A'.repeat(43), recoverSignPub: 'A'.repeat(43),
  smpKdf, recoveryKdf, envelopeSmp: envelope, envelopeRecovery: envelope,
  envelopeAccountVersion: '1',
  recoveryCodeSetTime: null,
};

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

describe('assertBase64UrlRange', () => {
  it('接受 [min,max] 内长度', () => {
    expect(assertBase64UrlRange('AA', 1, 256 * 1024, 'x')).toHaveLength(1);
  });

  it('拒绝空 / 超长', () => {
    expect(() => assertBase64UrlRange('', 1, 256 * 1024, 'x')).toThrow(/unpadded base64url/);
    expect(() => assertBase64UrlRange('A'.repeat(400000), 1, 256 * 1024, 'x')).toThrow(/decode/);
  });
});

describe('validateSyncState（服务端 /state 响应契约）', () => {
  it('合法 state 通过并返回关键计数器', () => {
    expect(validateSyncState(state)).toMatchObject({ keyEpoch: '1', stateVersion: '1', changeSequence: '0' });
  });

  it('缺字段拒绝', () => {
    const { envelopeSmp: _drop, ...rest } = state;
    expect(() => validateSyncState(rest)).toThrow();
  });

  it('counter 非字符串拒绝', () => {
    expect(() => validateSyncState({ ...state, keyEpoch: 1 })).toThrow(/string/);
    expect(() => validateSyncState({ ...state, changeSequence: null })).toThrow(/string/);
  });

  it('signPub 长度错误拒绝', () => {
    expect(() => validateSyncState({ ...state, signPub: 'A'.repeat(10) })).toThrow(/decode/);
  });

  it('envelope 短名 version/ct / 缺协议字段拒绝（对齐服务端长名契约）', () => {
    const short = { version: '1', nonce: 'A'.repeat(16), ct: 'A'.repeat(43), tag: 'A'.repeat(22) };
    expect(() => validateSyncState({ ...state, envelopeSmp: short })).toThrow();
  });

  it('非法 KDF 参数拒绝', () => {
    expect(() => validateSyncState({ ...state, smpKdf: { ...smpKdf, memoryKiB: 1024 } })).toThrow(/memoryKiB/);
  });

  it('额外字段拒绝', () => {
    expect(() => validateSyncState({ ...state, extra: 1 })).toThrow(/unexpected/);
  });

  it('envelopeAccountVersion 为合法 u64 字符串时通过', () => {
    expect(validateSyncState({ ...state, envelopeAccountVersion: '1' })).toMatchObject({ envelopeAccountVersion: '1' });
  });

  it('envelopeAccountVersion 非字符串 / 非法 u64 拒绝', () => {
    expect(() => validateSyncState({ ...state, envelopeAccountVersion: 1 })).toThrow(/envelopeAccountVersion/);
    expect(() => validateSyncState({ ...state, envelopeAccountVersion: '01' })).toThrow();
  });

  it('envelopeAccountVersion 字段缺失时拒绝（必填契约，fail-closed）', () => {
    const { envelopeAccountVersion: _drop, ...missing } = state;
    expect(() => validateSyncState(missing)).toThrow(/envelopeAccountVersion/);
  });
});

describe('validateAccountRecoveryMaterial（recover-via-account 响应契约，fail-closed）', () => {
  const material = { accountRecoveryKey: 'A'.repeat(43), envelopeAccount: envelope };

  it('合法材料通过', () => {
    expect(validateAccountRecoveryMaterial(material)).toEqual(material);
  });

  it('非对象拒绝', () => {
    expect(() => validateAccountRecoveryMaterial(null)).toThrow(/must be an object/);
    expect(() => validateAccountRecoveryMaterial('x')).toThrow(/must be an object/);
  });

  it('accountRecoveryKey 非字符串 / 长度不符拒绝', () => {
    expect(() => validateAccountRecoveryMaterial({ ...material, accountRecoveryKey: 1 })).toThrow(/must be a string/);
    expect(() => validateAccountRecoveryMaterial({ ...material, accountRecoveryKey: 'A'.repeat(10) })).toThrow(/decode/);
  });

  it('accountRecoveryKey 带 padding 拒绝', () => {
    expect(() => validateAccountRecoveryMaterial({ ...material, accountRecoveryKey: `${'A'.repeat(43)}=` })).toThrow(/unpadded base64url/);
  });

  it('envelopeAccount 非法（协议常量错误）拒绝', () => {
    expect(() => validateAccountRecoveryMaterial({ ...material, envelopeAccount: { ...envelope, cipherSuite: 'AES-128-GCM' as never } })).toThrow(/cipher/);
  });

  it('缺字段拒绝', () => {
    const { envelopeAccount: _drop, ...rest } = material;
    expect(() => validateAccountRecoveryMaterial(rest)).toThrow();
  });

  it('额外字段拒绝', () => {
    expect(() => validateAccountRecoveryMaterial({ ...material, bogus: true })).toThrow(/unexpected/);
  });
});
