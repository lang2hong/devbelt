import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { resolveSigningKeys } from '../../src/service/signingKeys.js';

const b64 = (pem: string | Buffer): string => Buffer.from(pem).toString('base64');

function ed25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    priv: b64(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    pub: b64(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

function rsaPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    priv: b64(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    pub: b64(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

const env = (over: Record<string, string>) => ({ ...over } as NodeJS.ProcessEnv);

describe('resolveSigningKeys', () => {
  it('resolves a valid Ed25519 key pair', () => {
    const a = ed25519Pair();
    const keys = resolveSigningKeys(
      env({ DEVBELT_DB_TOKEN_SIGNING_KEY_B64: a.priv, DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON: JSON.stringify({ k1: a.pub }) }),
    );
    expect(keys.kid).toBe('k1');
    expect(keys.privateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('rejects a missing signing key', () => {
    expect(() => resolveSigningKeys(env({ DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON: '{}' }))).toThrow(/DEVBELT_DB_TOKEN_SIGNING_KEY_B64/);
  });

  it('rejects a non-Ed25519 private key', () => {
    const rsa = rsaPair();
    const a = ed25519Pair();
    expect(() =>
      resolveSigningKeys(env({ DEVBELT_DB_TOKEN_SIGNING_KEY_B64: rsa.priv, DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON: JSON.stringify({ k1: a.pub }) })),
    ).toThrow(/not an Ed25519 key/);
  });

  it('rejects a non-Ed25519 public key', () => {
    const a = ed25519Pair();
    const rsa = rsaPair();
    expect(() =>
      resolveSigningKeys(env({ DEVBELT_DB_TOKEN_SIGNING_KEY_B64: a.priv, DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON: JSON.stringify({ k1: rsa.pub }) })),
    ).toThrow(/not an Ed25519 key/);
  });

  it('rejects a private/public mismatch for the current kid', () => {
    const a = ed25519Pair();
    const b = ed25519Pair();
    expect(() =>
      resolveSigningKeys(env({ DEVBELT_DB_TOKEN_SIGNING_KEY_B64: a.priv, DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON: JSON.stringify({ k1: b.pub }) })),
    ).toThrow(/private\/public key mismatch/);
  });

  it('rejects when the signing kid has no public key', () => {
    const a = ed25519Pair();
    expect(() =>
      resolveSigningKeys(
        env({ DEVBELT_DB_TOKEN_SIGNING_KID: 'k9', DEVBELT_DB_TOKEN_SIGNING_KEY_B64: a.priv, DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON: JSON.stringify({ k1: a.pub }) }),
      ),
    ).toThrow(/has no matching public key/);
  });
});