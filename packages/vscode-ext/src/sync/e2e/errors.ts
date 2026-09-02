/**
 * 本地脏冲突：本地连接自最后成功应用/确认后发生变更，且远端 pull 到更高 version。
 * UI 负责提供用户可见的解决策略；本错误不含任何明文连接内容、秘密或 URI。
 */
export class RecordConflictError extends Error {
  constructor(
    public readonly recordId: string,
    public readonly confirmedVersion: string,
    public readonly remoteVersion: string,
    public readonly kind: 'version' | 'pending' = 'version',
  ) {
    super(kind === 'pending'
      ? `record conflict (pending reservation): recordId=${recordId}`
      : `record conflict: recordId=${recordId}, remote version ${remoteVersion} > confirmed ${confirmedVersion}`);
    this.name = 'RecordConflictError';
  }
}
