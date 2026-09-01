import { assertU64Decimal } from './types';

/**
 * 本地 sync state 快照（B3a，§8.1.4）。
 *
 * 仅持久化服务端确认的 keyEpoch / stateVersion / changeSequence，供乐观锁与签名。
 * `changeSequence` 是用户级全局单调游标：客户端**只能**持久化服务端返回值，不得
 * 本地递增或推测。`setSnapshot` 单调防旧响应回退（changeSequence / keyEpoch 不得
 * 回退）。键按 userId 隔离；userId 必须先通过规范正 u64 校验。
 */

export interface SyncStateSnapshot {
  keyEpoch: string;
  stateVersion: string;
  changeSequence: string;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export class StateStore {
  private static readonly KEY_PREFIX = 'dbclient.sync.v3.state';

  private readonly key: string;

  constructor(
    private readonly memento: MementoLike,
    userId: string,
  ) {
    assertU64Decimal(userId, 'userId');
    this.key = `${StateStore.KEY_PREFIX}.${userId}`;
  }

  getSnapshot(): SyncStateSnapshot | undefined {
    const raw = this.memento.get<unknown>(this.key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null) throw new Error('corrupt sync state snapshot');
    const o = raw as Record<string, unknown>;
    return {
      keyEpoch: assertU64Decimal(String(o.keyEpoch), 'keyEpoch'),
      stateVersion: assertU64Decimal(String(o.stateVersion), 'stateVersion'),
      changeSequence: assertU64Decimal(String(o.changeSequence), 'changeSequence', true),
    };
  }

  setSnapshot(snapshot: SyncStateSnapshot): void {
    const keyEpoch = assertU64Decimal(snapshot.keyEpoch, 'keyEpoch');
    const stateVersion = assertU64Decimal(snapshot.stateVersion, 'stateVersion');
    const changeSequence = assertU64Decimal(snapshot.changeSequence, 'changeSequence', true);

    const prev = this.getSnapshot();
    if (prev) {
      if (BigInt(changeSequence) < BigInt(prev.changeSequence)) {
        throw new Error('changeSequence must not regress');
      }
      if (BigInt(keyEpoch) < BigInt(prev.keyEpoch)) {
        throw new Error('keyEpoch must not regress');
      }
    }

    void this.memento.update(this.key, { keyEpoch, stateVersion, changeSequence });
  }
}