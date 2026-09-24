import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sealEnvelope } from '@devbelt/db-host/sync/envelope';
import { sealRecord } from '@devbelt/db-host/sync/e2e/recordCodec';
import { encodeBase64Url } from '@devbelt/db-host/sync/crypto/recoveryCode';
import { unlockDekBrowser, smpKdfDtoToParams, type SmpKdfDto } from './unlock';
import { openCipherRecord } from './record';
import { DekSession } from './dekSession';
import { totpWeb } from './totpWeb';

const USER = '7';
const EPOCH = '1';
const KEK = new Uint8Array(32).fill(1);
const DEK = new Uint8Array(32).fill(2);
const DTO: SmpKdfDto = {
  alg: 'argon2id', version: 1, memoryKiB: 65536, iterations: 3, parallelism: 1,
  salt: encodeBase64Url(new Uint8Array(16).fill(9)), outputBytes: 32,
};
const deriveKek = async (): Promise<Uint8Array> => KEK;

describe('P6-S5b unlockDekBrowser', () => {
  it('unwraps DEK from envelopeSmp with injected KDF', async () => {
    const envelopeSmp = sealEnvelope(KEK, DEK, USER, EPOCH, 'smp');
    const dek = await unlockDekBrowser(USER, EPOCH, 'smp', DTO, envelopeSmp, deriveKek);
    expect(Array.from(dek)).toEqual(Array.from(DEK));
  });

  it('fails closed with a wrong KEK', async () => {
    const envelopeSmp = sealEnvelope(KEK, DEK, USER, EPOCH, 'smp');
    await expect(
      unlockDekBrowser(USER, EPOCH, 'smp', DTO, envelopeSmp, async () => new Uint8Array(32).fill(3)),
    ).rejects.toThrow();
  });

  it('smpKdfDtoToParams rejects out-of-range params', () => {
    expect(() => smpKdfDtoToParams({ ...DTO, memoryKiB: 1024 })).toThrow(/memoryKiB/);
  });
});

describe('P6-S5b openCipherRecord', () => {
  it('decrypts an authenticated record and rejects wrong DEK / tombstone', async () => {
    const payload = { type: 'authenticatorEntry', issuer: 'Acme', secret: 'JBSWY3DPEHPK3PXP' };
    const nonce = new Uint8Array(randomBytes(12));
    const recordId = 'R'.repeat(22);
    const box = sealRecord(DEK, nonce, new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')), {
      userId: USER, keyEpoch: EPOCH, recordId, recordVersion: '1',
    });
    const rec = {
      recordId, version: '1', changeSequence: '1', deleteTime: null,
      nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(box.ciphertext), tag: encodeBase64Url(box.tag),
    };
    expect(await openCipherRecord(DEK, rec, { userId: USER, keyEpoch: EPOCH })).toEqual(payload);
    await expect(openCipherRecord(new Uint8Array(32).fill(4), rec, { userId: USER, keyEpoch: EPOCH })).rejects.toThrow();
    expect(await openCipherRecord(DEK, { ...rec, deleteTime: '2026-01-01T00:00:00.000Z' }, { userId: USER, keyEpoch: EPOCH })).toBeUndefined();
  });
});

describe('P6-S5c totpWeb', () => {
  it('matches RFC 6238 SHA1 8-digit vector at T=59', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
    const { code } = await totpWeb(secret, 59_000, 30, 8, 'SHA1');
    expect(code).toBe('94287082');
  });
});

describe('P6-S5b DekSession', () => {
  it('holds DEK in memory only and zeroes on clear', () => {
    const s = new DekSession();
    expect(s.isUnlocked).toBe(false);
    s.set(DEK);
    expect(s.isUnlocked).toBe(true);
    const held = s.get()!;
    s.clear();
    expect(s.isUnlocked).toBe(false);
    expect(s.get()).toBeUndefined();
    expect(Array.from(held)).toEqual(new Array(32).fill(0));
    expect(() => s.set(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
