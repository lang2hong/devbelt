/**
 * 本地凭据映射：组织模板通过 organizationId + resourceId 映射用户自己的本地凭据，映射不上传服务端。
 *
 * 三段硬保证：
 *  1. 只写 vscode.SecretStorage（个人密钥存储），绝不写个人 ConnectionStore；
 *  2. 键为 `devbelt.org.credential.<organizationId>.<resourceId>`，不含服务器 content；
 *  3. 凭据只用于本地建连（材料化为临时 ConnectionConfig），绝不进任何 HTTP 请求体 ——
 *     该保证由 OrgClient 的结构保证（发送字段不含凭据），见 client.ts。
 */
import type { Memento, SecretStorage } from 'vscode';

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
  /** 本机 CA 证书路径（verify-ca/verify-full 时本地选择；路径非秘密，但也不应持久化上传）。 */
  caPath?: string;
}

const KEY_PREFIX = 'devbelt.org.credential';
const INDEX_KEY = 'devbelt.org.credential.index';

export class CredentialVault {
  constructor(
    private readonly secrets: SecretStorage,
    private readonly index: Memento,
  ) {}

  static key(organizationId: string, resourceId: string): string {
    return `${KEY_PREFIX}.${organizationId}.${resourceId}`;
  }

  private getIndex(): string[] {
    return this.index.get<string[]>(INDEX_KEY, []);
  }

  private async setIndex(keys: string[]): Promise<void> {
    await this.index.update(INDEX_KEY, keys);
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
    const key = CredentialVault.key(organizationId, resourceId);
    await this.secrets.store(key, JSON.stringify(cred));
    const keys = this.getIndex();
    if (!keys.includes(key)) {
      keys.push(key);
      await this.setIndex(keys);
    }
  }

  async delete(organizationId: string, resourceId: string): Promise<void> {
    const key = CredentialVault.key(organizationId, resourceId);
    await this.secrets.delete(key);
    const keys = this.getIndex().filter((k) => k !== key);
    await this.setIndex(keys);
  }

  /**
   * 删除当前 index 登记过的全部组织凭据并在全部成功后清空 index。
   *
   * SecretStorage 不支持 key 枚举，因此这里只能依赖本客户端自登记的 index；
   * 升级前已存在但未登记的历史凭据无法被追溯清除，属开发期已知限制。
   * 删除失败的 key 会保留在 index 中，以便后续 logout/重试仍有清理入口。
   */
  async clearAll(): Promise<void> {
    const keys = [...this.getIndex()];
    const remaining: string[] = [];
    for (const key of keys) {
      try {
        await this.secrets.delete(key);
      } catch {
        remaining.push(key);
      }
    }
    await this.setIndex(remaining);
  }
}
