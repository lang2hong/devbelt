import { createHash, randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';

/** Per-workspace masking salt. Stored in SecretStorage; never exported. */
export async function getProjectSalt(secrets: vscode.SecretStorage, workspacePath: string): Promise<string> {
  const id = createHash('sha256').update(workspacePath, 'utf8').digest('hex').slice(0, 16);
  const key = `devbelt.masking.salt.${id}`;
  const existing = await secrets.get(key);
  if (existing) return existing;
  const salt = randomBytes(32).toString('base64url');
  await secrets.store(key, salt);
  return salt;
}