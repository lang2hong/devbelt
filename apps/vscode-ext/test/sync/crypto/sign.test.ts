import { describe, expect, it } from 'vitest';
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  buildRecordSigningInput,
  buildStateSigningInput,
  signSigningInput,
  SYNC_DOMAIN,
} from '../../../src/sync/crypto/sign';
import { requestDigestOf } from '../../../src/sync/crypto/digest';
import { deriveEd25519KeyPair, signEd25519 } from '../../../src/sync/crypto/ed25519';
import { SYNC_SIGN_TEST_VECTOR } from '@devkit/db-core/testing';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

describe('sign action 构造表（与服务端 assertSignature 对齐）', () => {
  it('record.put/delete 含 recordId + baseVersion，无 expectedStateVersion', () => {
    const input = buildRecordSigningInput('record.put', {
      userId: '7', keyEpoch: '1', recordId: 'rcid', baseVersion: '0', mutationId: 'm', requestDigest: 'd',
    });
    expect(input).toEqual({
      domain: SYNC_DOMAIN, action: 'record.put', userId: '7', keyEpoch: '1',
      recordId: 'rcid', baseVersion: '0', mutationId: 'm', requestDigest: 'd',
    });
    expect('expectedStateVersion' in input).toBe(false);
  });

  it('state.change-key/recover/destroy 含 expectedStateVersion，无 recordId/baseVersion', () => {
    const input = buildStateSigningInput('state.recover', {
      userId: '7', keyEpoch: '1', expectedStateVersion: '3', mutationId: 'm', requestDigest: 'd',
    });
    expect(input).toEqual({
      domain: SYNC_DOMAIN, action: 'state.recover', userId: '7', keyEpoch: '1',
      expectedStateVersion: '3', mutationId: 'm', requestDigest: 'd',
    });
    expect('recordId' in input).toBe(false);
    expect('baseVersion' in input).toBe(false);
  });
});

describe('requestDigest 顺序锚定', () => {
  it('digest 来自 body（无 signature），signingInput 复用同一 digest', () => {
    const body = { protocolVersion: 1, keyEpoch: '1', mutationId: 'm', expectedStateVersion: '3' };
    const digest = requestDigestOf(body);
    const input = buildStateSigningInput('state.change-key', {
      userId: '7', keyEpoch: '1', expectedStateVersion: '3', mutationId: 'm', requestDigest: digest,
    });
    const sig = signSigningInput(input, new Uint8Array(32).fill(1));
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/); // 64B → 86 chars base64url 无 padding
  });
});

describe('互通：@noble sign ↔ Node crypto.verify', () => {
  it('Node 能验 @noble 签名，篡改消息失败', () => {
    const seed = new Uint8Array(32).fill(7);
    const kp = deriveEd25519KeyPair(seed);
    const msg = Buffer.from('hello');
    const sig = signEd25519(msg, seed);
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(kp.publicKey)]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(cryptoVerify(null, msg, pub, Buffer.from(sig))).toBe(true);
    expect(cryptoVerify(null, Buffer.from('tampered'), pub, Buffer.from(sig))).toBe(false);
  });

  it('互通向量（单一源）：@noble 复算得到同一公钥与签名', () => {
    const seed = new Uint8Array(Buffer.from(SYNC_SIGN_TEST_VECTOR.seedHex, 'hex'));
    const kp = deriveEd25519KeyPair(seed);
    expect(Buffer.from(kp.publicKey).toString('hex')).toBe(SYNC_SIGN_TEST_VECTOR.publicKeyHex);
    const msg = new TextEncoder().encode(SYNC_SIGN_TEST_VECTOR.message);
    expect(Buffer.from(signEd25519(msg, seed)).toString('base64url')).toBe(SYNC_SIGN_TEST_VECTOR.signatureB64Url);
  });
});
