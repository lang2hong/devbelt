/**
 * 本地凭据映射（§6.2「组织模板通过 organizationId + resourceId 映射用户自己的本地凭据」）。
 *
 * 三段硬保证：
 *  1. 只写 vscode.SecretStorage（个人密钥存储），绝不写个人 ConnectionStore；
 *  2. 键为 `dbclient.org.credential.<organizationId>.<resourceId>`，不含服务器 content；
 *  3. 凭据只用于本地建连（材料化为临时 ConnectionConfig），绝不进任何 HTTP 请求体 ——
 *     该保证由 OrgClient 的结构保证（发送字段不含凭据），见 client.ts。
 */
import type { SecretStorage } from 'vscode';

export interface OrgLocalCredential {
  /** 连接密码（模板不含密码，由用户本地提供）。 */
  password?: string;
  /** 本地覆盖用户名（模板未提供 username 时可选）。 */
  username?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
  sshPrivateKeyPath?: string;
  sshPassphrase?: string;
}

const KEY_PREFIX = 'dbclient.org.credential';

export class CredentialVault {
  constructor(private readonly secrets: SecretStorage) {}

  static key(organizationId: string, resourceId: string): string {
    return `${KEY_PREFIX}.${organizationId}.${resourceId}`;
  }

  async get(organizationId: string, resourceId: string): Promise<OrgLocalCredential | undefined> {
    const raw = await this.secrets.get(CredentialVault.key(organizationId, resourceId));
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as OrgLocalCredential;
    } catch {
      return undefined;
    }
  }

  async set(organizationId: string, resourceId: string, cred: OrgLocalCredential): Promise<void> {
    await this.secrets.store(CredentialVault.key(organizationId, resourceId), JSON.stringify(cred));
  }

  async delete(organizationId: string, resourceId: string): Promise<void> {
    await this.secrets.delete(CredentialVault.key(organizationId, resourceId));
  }
}