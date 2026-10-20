import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

let parseTrustProxy: typeof import('../../src/config.js').parseTrustProxy;
const saved = {
  nodeEnv: process.env.NODE_ENV,
  sign: process.env.DEVBELT_DB_TOKEN_SIGNING_KEY_B64,
  verify: process.env.DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON,
  trust: process.env.DEVBELT_DB_TRUST_PROXY,
};

beforeAll(async () => {
  // config.ts 在模块加载时解析签名密钥与环境；先构造一套临时合法配置。
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const pub = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  process.env.NODE_ENV = 'development';
  process.env.DEVBELT_DB_TOKEN_SIGNING_KEY_B64 = Buffer.from(priv).toString('base64');
  process.env.DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON = JSON.stringify({
    k1: Buffer.from(pub).toString('base64'),
  });
  delete process.env.DEVBELT_DB_TRUST_PROXY;
  ({ parseTrustProxy } = await import('../../src/config.js'));
});

afterAll(() => {
  for (const [key, value] of [
    ['NODE_ENV', saved.nodeEnv],
    ['DEVBELT_DB_TOKEN_SIGNING_KEY_B64', saved.sign],
    ['DEVBELT_DB_TOKEN_VERIFY_KEYS_JSON', saved.verify],
    ['DEVBELT_DB_TRUST_PROXY', saved.trust],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseTrustProxy', () => {
  it('未配置时默认不信任代理（开发/未声明环境）', () => {
    expect(parseTrustProxy(undefined, 'development')).toBe(false);
    expect(parseTrustProxy('', 'development')).toBe(false);
  });

  it('生产环境必须显式配置，避免直连时信任客户端 XFF', () => {
    expect(() => parseTrustProxy(undefined, 'production')).toThrow(/must be set explicitly/);
    expect(parseTrustProxy('1', 'production')).toBe('1');
    expect(parseTrustProxy('false', 'production')).toBe(false);
  });

  it('拒绝 true（取最左段 XFF，可被客户端伪造）', () => {
    expect(() => parseTrustProxy('true', 'development')).toThrow(/refused/);
  });
});