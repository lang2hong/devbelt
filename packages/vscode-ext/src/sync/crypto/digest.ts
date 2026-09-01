import { createHash } from 'crypto';
import { jcs } from './jcs';

/** requestDigest = SHA-256(JCS(body 除 signature))，base64url 无 padding（§8.1.8）。 */
export function requestDigestOf(bodyWithoutSignature: unknown): string {
  const hash = createHash('sha256').update(Buffer.from(jcs(bodyWithoutSignature), 'utf8')).digest();
  return hash.toString('base64url');
}
