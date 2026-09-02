import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';

/**
 * Ed25519 签名密钥解析。
 *
 * 独立成模块以便单独测试（config.ts 顶层会立即用 process.env 求值，import 即
 * 可能抛错；本模块是纯函数，只接受显式 env 参数）。
 */
export interface SigningKeys {
  kid: string;
  privateKey: KeyObject;
  publicKeys: ReadonlyMap<string, KeyObject>;
}

function decodePem(b64: string, varName: string): string {
  let pem: string;
  try {
    pem = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    throw new Error(`${varName} is not valid base64`);
  }
  if (!pem.includes('-----BEGIN')) throw new Error(`${varName} does not decode to a PEM key`);
  return pem;
}

export function resolveSigningKeys(env: NodeJS.ProcessEnv = process.env): SigningKeys {
  const kid = (env.TOKEN_SIGNING_KID || 'k1').trim();
  const signB64 = (env.TOKEN_SIGNING_KEY_B64 || '').trim();
  if (!signB64) {
    throw new Error(
      'TOKEN_SIGNING_KEY_B64 is required: provide a base64-encoded Ed25519 PKCS8 PEM. ' +
        'Generate with: openssl genpkey -algorithm ed25519 | base64 -w0',
    );
  }

  const privateKey = createPrivateKey({ key: decodePem(signB64, 'TOKEN_SIGNING_KEY_B64'), format: 'pem' });

  const verifyRaw = (env.TOKEN_VERIFY_KEYS_JSON || '').trim();
  if (!verifyRaw) {
    throw new Error(
      'TOKEN_VERIFY_KEYS_JSON is required: a JSON map of kid -> base64 Ed25519 SPKI PEM.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifyRaw);
  } catch {
    throw new Error('TOKEN_VERIFY_KEYS_JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TOKEN_VERIFY_KEYS_JSON must be a JSON object of {kid: spki-base64}');
  }

  const publicKeys = new Map<string, KeyObject>();
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`TOKEN_VERIFY_KEYS_JSON["${k}"] must be a string`);
    publicKeys.set(k, createPublicKey({ key: decodePem(v, `TOKEN_VERIFY_KEYS_JSON["${k}"]`), format: 'pem' }));
  }
  if (!publicKeys.has(kid)) {
    throw new Error(`TOKEN_SIGNING_KID "${kid}" has no matching public key in TOKEN_VERIFY_KEYS_JSON`);
  }

  // 签名密钥必须是 Ed25519（否则 jose 会在首个签名/验签时失败，而非启动失败）。
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `TOKEN_SIGNING_KEY_B64 is not an Ed25519 key (got ${privateKey.asymmetricKeyType}). Generate with: openssl genpkey -algorithm ed25519`,
    );
  }
  for (const [k, pub] of publicKeys) {
    if (pub.asymmetricKeyType !== 'ed25519') {
      throw new Error(`TOKEN_VERIFY_KEYS_JSON["${k}"] is not an Ed25519 key (got ${pub.asymmetricKeyType})`);
    }
  }
  // 当前 kid 的公私钥必须匹配（启动即验证，避免轮换配错拖到首个请求才失败）。
  const expectedPubDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
  const kidPubDer = publicKeys.get(kid)!.export({ type: 'spki', format: 'der' }) as Buffer;
  if (!expectedPubDer.equals(kidPubDer)) {
    throw new Error(`TOKEN_SIGNING_KID "${kid}" private/public key mismatch`);
  }

  return { kid, privateKey, publicKeys };
}
