import { describe, expect, it } from 'vitest';
import { envelopeInfo, hkdfSha256, SYNC_INFO } from '../../../src/sync/crypto/hkdf';

describe('hkdf', () => {
  it('envelopeInfo 模板拼接', () => {
    expect(envelopeInfo('1', 'smp', '2')).toBe('dbclient/sync/v1/envelope/1/smp/2');
    expect(envelopeInfo('3', 'recovery', '1')).toBe('dbclient/sync/v1/envelope/3/recovery/1');
  });

  it('HKDF-SHA256 确定性（同输入同输出，默认 32B）', () => {
    const ikm = new Uint8Array(32).fill(7);
    const a = hkdfSha256(ikm, new Uint8Array(0), SYNC_INFO.signing);
    const b = hkdfSha256(ikm, new Uint8Array(0), SYNC_INFO.signing);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('不同 info 产出不同密钥', () => {
    const ikm = new Uint8Array(32).fill(9);
    const a = hkdfSha256(ikm, new Uint8Array(0), SYNC_INFO.signing);
    const b = hkdfSha256(ikm, new Uint8Array(0), SYNC_INFO.recoverSigning);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('空 salt 与有 salt 产出不同（salt 区分域）', () => {
    const ikm = new Uint8Array(32).fill(1);
    const a = hkdfSha256(ikm, new Uint8Array(0), SYNC_INFO.kekRecovery);
    const b = hkdfSha256(ikm, new Uint8Array(16).fill(3), SYNC_INFO.kekRecovery);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });
});