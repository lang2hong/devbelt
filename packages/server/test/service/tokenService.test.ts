import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { TokenService, type SigningKeys } from '../../src/service/tokenService.js';

function makeKeys(kid = 'k1'): { keys: SigningKeys; otherPublic: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { publicKey: otherPublic } = generateKeyPairSync('ed25519');
  return {
    keys: { kid, privateKey, publicKeys: new Map([[kid, publicKey]]) },
    otherPublic,
  };
}

describe('TokenService (Ed25519)', () => {
  const sign = (svc: TokenService, userId: number) =>
    svc.signAccessToken({ userId, aud: 'extension', scope: ['sync', 'account'], sessionId: 'fam-1', sessionVersion: 0 });

  it('signs and verifies an access token carrying sub/jti/aud/scope/session', async () => {
    const { keys } = makeKeys();
    const svc = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
    const token = await sign(svc, 42);
    const payload = await svc.verifyAccessToken(token);
    expect(payload.sub).toBe('42');
    expect(payload.jti).toBeTypeOf('string');
    expect(payload.iat).toBeTypeOf('number');
    expect(payload.exp).toBeTypeOf('number');
    expect(payload.aud).toBe('extension');
    expect(payload.scope).toEqual(['sync', 'account']);
    expect(payload.sessionId).toBe('fam-1');
    expect(payload.sessionVersion).toBe(0);
  });

  it('rejects a token signed by a different key', async () => {
    const { keys, otherPublic } = makeKeys();
    const svc = new TokenService(keys, '15m', 30 * 24 * 3600 * 1000);
    const token = await sign(svc, 1);
    // 换一套公钥集验证同一 token（kid 相同但 key 不同）
    const alt: SigningKeys = { kid: 'k1', privateKey: keys.privateKey, publicKeys: new Map([['k1', otherPublic]]) };
    await expect(new TokenService(alt, '15m', 1).verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects an unknown kid', async () => {
    const { keys } = makeKeys('k1');
    const svc = new TokenService(keys, '15m', 1);
    const { keys: otherKeys } = makeKeys('k2');
    const other = new TokenService(otherKeys, '15m', 1);
    const token = await sign(other, 1);
    await expect(svc.verifyAccessToken(token)).rejects.toThrow();
  });

  it('generates 256-bit refresh tokens and hashes to 64 hex chars', () => {
    const { keys } = makeKeys();
    const svc = new TokenService(keys, '15m', 1000);
    const { token, hash, expiresAt } = svc.generateRefreshToken();
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(svc.hashToken(token)).toBe(hash);
  });
});