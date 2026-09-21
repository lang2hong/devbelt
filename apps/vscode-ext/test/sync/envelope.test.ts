import { describe, expect, it } from 'vitest';
import { sealEnvelope, openEnvelope } from '@devbelt/db-host/sync/envelope';

const kek = new Uint8Array(32).fill(1);
const dek = new Uint8Array(32);

describe('密钥 envelope', () => {
  it('smp/recovery 均 seal→open 往返一致', () => {
    for (const purpose of ['smp', 'recovery'] as const) {
      const e = sealEnvelope(kek, dek, '7', '1', purpose, '1');
      const out = openEnvelope(kek, e, '7', '1', purpose);
      expect(Buffer.from(out).toString('hex')).toBe(Buffer.from(dek).toString('hex'));
      expect(e.cipherSuite).toBe('AES-256-GCM');
    }
  });

  it('AAD 不一致（purpose 不同）→ open 失败', () => {
    const e = sealEnvelope(kek, dek, '7', '1', 'smp', '1');
    expect(() => openEnvelope(kek, e, '7', '1', 'recovery')).toThrow();
  });

  it('keyEpoch 不一致 → open 失败', () => {
    const e = sealEnvelope(kek, dek, '7', '1', 'smp', '1');
    expect(() => openEnvelope(kek, e, '7', '2', 'smp')).toThrow();
  });

  it('kek 不同 → open 失败', () => {
    const e = sealEnvelope(kek, dek, '7', '1', 'smp', '1');
    expect(() => openEnvelope(new Uint8Array(32).fill(9), e, '7', '1', 'smp')).toThrow();
  });
});