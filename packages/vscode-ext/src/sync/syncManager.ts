import { ConnectionStore, ConnectionTreeData } from '../connection/connectionStore';
import { AuthService } from './authService';
import { Encryption } from './encryption';

/**
 * 同步管理器：协调 认证 + 加密 + 数据拉取/推送。
 *  - 推送：加密本地树数据 → 上传（带乐观锁 version）
 *  - 拉取：下载密文 → 解密 → 合并到本地
 */
export class SyncManager {
  private version = 0;

  constructor(
    private readonly auth: AuthService,
    private readonly store: ConnectionStore,
  ) {}

  /** 拉取远端数据并合并到本地 */
  async pull(masterPassword: string): Promise<void> {
    const { data, version } = await this.auth.client.fetch();
    this.version = version;
    if (!data) {
      // 远端无数据，无需合并
      return;
    }
    const remote = Encryption.decrypt(data, masterPassword) as ConnectionTreeData;
    await this.store.replaceAll(remote);
  }

  /** 推送本地数据到远端 */
  async push(masterPassword: string): Promise<void> {
    const local = this.store.getSyncTreeData();
    const encrypted = Encryption.encrypt(local, masterPassword);
    const { version } = await this.auth.client.push(encrypted, this.version);
    this.version = version;
  }

  /** 强制推送：以指定远端版本为基准重推本地数据（显式覆盖远端）。 */
  async forcePush(masterPassword: string, baseVersion: number): Promise<void> {
    const local = this.store.getSyncTreeData();
    const encrypted = Encryption.encrypt(local, masterPassword);
    const { version } = await this.auth.client.push(encrypted, baseVersion);
    this.version = version;
  }

  /** 当前同步版本（冲突检测用） */
  getVersion(): number {
    return this.version;
  }
}
