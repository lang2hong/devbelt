import type { SecretStorage } from 'vscode';

/**
 * 主密码本地记忆（opt-in）：仅当用户开启 `dbclient.sync.rememberMaster` 时使用。
 * 主密码只存于本机 SecretStorage（OS 钥匙串加密），**从不上传**。
 * 用于 silent 自动同步：背景静默加解密，无需每次输入主密码。
 */
export class MasterPasswordStore {
  private static readonly KEY = 'dbclient.sync.masterPassword';

  constructor(private readonly secrets: SecretStorage) {}

  /** 记住主密码（本机存储） */
  async store(masterPassword: string): Promise<void> {
    await this.secrets.store(MasterPasswordStore.KEY, masterPassword);
  }

  /** 读取已记住的主密码；未记住返回 undefined */
  async get(): Promise<string | undefined> {
    return this.secrets.get(MasterPasswordStore.KEY);
  }

  /** 清除已记住的主密码 */
  async clear(): Promise<void> {
    await this.secrets.delete(MasterPasswordStore.KEY);
  }
}
