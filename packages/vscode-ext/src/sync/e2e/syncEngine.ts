import { PersonalSyncClient, SyncApiError } from './client';
import { openRecord } from './recordCodec';
import { applyRecord, type ApplyContext } from './applyRecords';
import { RecordConflictError } from './errors';
import type { RecordMapStore } from './recordMapStore';
import { PendingMutationStore, type PendingMutation } from './pendingMutationStore';
import type { StateStore } from './stateStore';
import type { ConnectionStore } from '../../connection/connectionStore';
import type { CachedEntitlement } from '../authService';
import { assertRecordId, assertU64Decimal } from './types';

/**
 * 个人同步运行循环（SyncEngine）。
 *
 * 只负责「已初始化、已持有 DEK」状态下的单轮同步，不持有密钥生命周期、不做 UI、不接
 * 连接变更监听（归任务 3/4）。并发调用单飞合并；一轮内固定顺序：
 *
 *   epoch 对账 → outbox 重放 → 分页 feed → 解密 + 安全应用 → 逐页保存 cursor
 *
 * 本轮只重放已持久化的 outbox（push 已签名 mutation，逐字复用 signature/requestDigest，
 * 不重新签名）；「本地连接变更 → 生成 mutation」的入口归任务 3。
 *
 * 失败语义：
 * - epoch 不匹配 → 停止 stage='epoch-mismatch'，不重试不覆盖。
 * - outbox 4xx（CONFLICT 等 terminal 码集合）→ terminal；其余（5xx/网络/401/429）保留 outbox 重演。
 * - 应用遇 RecordConflictError → 停在该 record，cursor 停在最后确认页，交任务 4 UI。
 * - 页内部分应用后重放：返回 changeSequence=最后确认页游标，下轮重拉重应用，依赖
 *   applyRecord 的 confirmed + version≤ 幂等收敛。
 */

export type SyncRunStage = 'ok' | 'epoch-mismatch' | 'conflict' | 'error' | 'terminal';

export interface SyncConflictEntry {
  recordId: string;
  kind: 'version' | 'pending';
  code?: string;
  currentVersion?: string;
}

export interface SyncTerminalEntry {
  mutationId: string;
  code?: string;
  currentKeyEpoch?: string;
}

export interface SyncStalledEntry {
  mutationId: string;
}

export interface SyncRunResult {
  stage: SyncRunStage;
  conflicts: SyncConflictEntry[];
  terminal?: SyncTerminalEntry;
  stalled?: SyncStalledEntry;
  applied: number;
  changeSequence?: string;
  reason?: string; // 不含秘密
}

interface RemoteState {
  keyEpoch: string;
  stateVersion: string;
  changeSequence: string;
}

interface RemoteRecord {
  recordId: string;
  version: string;
  changeSequence: string;
  deleteTime: string | null;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
}

interface PullPage {
  snapshotSequence: string;
  nextAfter?: string;
  records: RemoteRecord[];
}

const MAX_PAGES = 1000;
const STALL_THRESHOLD = 5;

type ErrorClass = 'terminal' | 'terminal-state' | 'terminal-epoch' | 'conflict' | 'retryable';

/** §7.4 重放与错误处置分类表。 */
function classifyError(e: SyncApiError): ErrorClass {
  switch (e.code) {
    case 'SYNC_PROTOCOL_UNSUPPORTED':
    case 'SYNC_SIGNATURE_INVALID':
    case 'VALIDATION_FAILED':
    case 'SYNC_NONCE_REUSED':
    case 'SYNC_QUOTA_EXCEEDED':
    case 'CONFLICT':
      return 'terminal';
    case 'SYNC_EPOCH_STALE':
      return 'terminal-epoch';
    case 'SYNC_NOT_INITIALIZED':
      return 'terminal-state';
    case 'SYNC_VERSION_CONFLICT':
      return 'conflict';
    default:
      return 'retryable';
  }
}

export interface SyncEngineDeps {
  userId: string;
  keyEpoch: string;
  client: PersonalSyncClient;
  stateStore: StateStore;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  store: ConnectionStore;
  /** DEK 数据加密密钥（解密 feed record）。 */
  dek: () => Uint8Array;
  /** 仅供任务 3「本地变更→mutation」首次签名；本轮 outbox 重放不调用。 */
  signSeed: () => Uint8Array;
  uniqueConnectionId: () => string;
  entitlement?: () => CachedEntitlement | undefined;
  feedPageLimit?: number;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SyncEngine {
  private inflight?: Promise<SyncRunResult>;

  constructor(private readonly deps: SyncEngineDeps) {
    if (deps.mapStore.userId !== deps.userId) throw new Error('mapStore userId mismatch');
    if (deps.outbox.userId !== deps.userId) throw new Error('outbox userId mismatch');
    if (deps.mapStore.keyEpoch !== deps.keyEpoch) throw new Error('mapStore keyEpoch mismatch');
    if (deps.outbox.keyEpoch !== deps.keyEpoch) throw new Error('outbox keyEpoch mismatch');
  }

  /** 单飞：并发 sync() 合并进同一轮，失败后清空允许下次重试（不产生未处理 rejection）。 */
  sync(): Promise<SyncRunResult> {
    if (this.inflight) return this.inflight;
    const p = this.run();
    this.inflight = p;
    void p.then(
      () => {
        if (this.inflight === p) this.inflight = undefined;
      },
      () => {
        if (this.inflight === p) this.inflight = undefined;
      },
    );
    return p;
  }

  private async run(): Promise<SyncRunResult> {
    const limit = this.deps.feedPageLimit ?? 256;

    // 1. epoch 对账
    let remoteState: RemoteState;
    try {
      remoteState = this.parseState(await this.deps.client.getState());
    } catch (err) {
      return { stage: 'error', conflicts: [], applied: 0, reason: `getState failed: ${describe(err)}` };
    }

    const local = this.deps.stateStore.getSnapshot();
    if (!local) {
      return { stage: 'epoch-mismatch', conflicts: [], applied: 0, reason: 'no local sync state (init required)' };
    }
    if (BigInt(local.keyEpoch) !== BigInt(this.deps.keyEpoch)) {
      return { stage: 'error', conflicts: [], applied: 0, reason: 'engine keyEpoch mismatch with local state' };
    }
    if (BigInt(remoteState.keyEpoch) !== BigInt(local.keyEpoch)) {
      return { stage: 'epoch-mismatch', conflicts: [], applied: 0, reason: 'remote keyEpoch differs from local' };
    }

    // 状态对账：同 epoch 但远端 stateVersion 已推进（如异设备 change-key/recover）时，
    // 无新 record 也须把本地 stateVersion 同步到远端，否则后续 expectedStateVersion 会冲突。
    // stateVersion 单调防回退：旧响应/服务端异常/竞态返回更小版本时 fail-closed，
    // 不进 outbox/feed，也不覆写本地快照。
    const remoteSv = BigInt(remoteState.stateVersion);
    const localSv = BigInt(local.stateVersion);
    if (remoteSv < localSv) {
      return { stage: 'error', conflicts: [], applied: 0, reason: 'remote stateVersion is behind local' };
    }
    if (remoteSv > localSv) {
      try {
        await this.deps.stateStore.setSnapshot({
          keyEpoch: local.keyEpoch,
          stateVersion: remoteState.stateVersion,
          changeSequence: local.changeSequence,
        });
      } catch (err) {
        return { stage: 'error', conflicts: [], applied: 0, reason: `state reconcile failed: ${describe(err)}` };
      }
    }

    // 2. outbox 重放：逐条直发已签名 mutation（逐字复用 signature/requestDigest，不重签）。
    // 成功 → 先确认 recordMap → 再删条目；确认失败保留条目原样重放（幂等 receipt 收敛）。
    let stalled: SyncStalledEntry | undefined;
    for (const m of this.deps.outbox.list()) {
      let receipt: unknown;
      try {
        receipt = await this.pushMutation(m);
      } catch (err) {
        if (err instanceof SyncApiError) {
          const cls = classifyError(err);
          if (cls === 'terminal' || cls === 'terminal-state' || cls === 'terminal-epoch') {
            return {
              stage: 'terminal', conflicts: [], applied: 0,
              terminal: { mutationId: m.mutationId, code: err.code, currentKeyEpoch: err.currentKeyEpoch },
              reason: cls === 'terminal-state'
                ? 'outbox mutation requires init / epoch handling'
                : cls === 'terminal-epoch' ? 'outbox mutation epoch stale' : undefined,
            };
          }
          if (cls === 'conflict') {
            return {
              stage: 'conflict',
              conflicts: [{ recordId: m.recordId, kind: 'version', code: err.code, currentVersion: err.currentVersion }],
              applied: 0,
              reason: 'outbox mutation version conflict',
            };
          }
          // 可重试 error：递增连续失败计数；1–4 中止本轮，≥5 保留条目、附 stalled、允许继续 pull。
          const nextCount = m.consecutiveFailureCount + 1;
          await this.deps.outbox.setFailureCount(m.mutationId, nextCount);
          if (nextCount >= STALL_THRESHOLD) {
            stalled = { mutationId: m.mutationId };
            break;
          }
          return { stage: 'error', conflicts: [], applied: 0, reason: `push failed: ${describe(err)}` };
        }
        return { stage: 'error', conflicts: [], applied: 0, reason: `push failed: ${describe(err)}` };
      }

      try {
        await this.confirmOutbound(m, receipt);
      } catch (err) {
        return { stage: 'error', conflicts: [], applied: 0, reason: `confirm failed: ${describe(err)}` };
      }
      await this.deps.outbox.delete(m.mutationId);
    }

    // 3. 分页 feed + 解密 + 应用 + 逐页 cursor
    const remoteSnap = remoteState.changeSequence;
    const ctx: ApplyContext = {
      store: this.deps.store,
      mapStore: this.deps.mapStore,
      entitlement: this.deps.entitlement?.(),
      uniqueConnectionId: this.deps.uniqueConnectionId,
    };

    let cursor = local.changeSequence;
    let lastCommitted = local.changeSequence;
    let applied = 0;
    const conflicts: SyncConflictEntry[] = [];

    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: 'paging exceeded limit' };
      }
      const requested = cursor;
      let page: PullPage;
      try {
        page = this.parsePage(await this.deps.client.getRecords(requested, remoteSnap, limit));
      } catch (err) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `pull failed: ${describe(err)}` };
      }
      if (page.snapshotSequence !== remoteSnap) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: 'snapshotSequence drift' };
      }

      if (page.records.length > 0) {
        for (const rec of page.records) {
          try {
            await this.applyRemote(rec, this.deps.keyEpoch, ctx);
            applied += 1;
          } catch (err) {
            if (err instanceof RecordConflictError) {
              conflicts.push({ recordId: rec.recordId, kind: err.kind });
              return { stage: 'conflict', conflicts, stalled, applied, changeSequence: lastCommitted };
            }
            return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `apply failed: ${describe(err)}` };
          }
        }
        const lastSeq = page.records[page.records.length - 1].changeSequence;
        try {
          await this.commitCursor(remoteState.keyEpoch, remoteState.stateVersion, lastSeq);
          lastCommitted = lastSeq;
        } catch (err) {
          return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `cursor commit failed: ${describe(err)}` };
        }
      }

      if (page.nextAfter === undefined) break;
      let nextAfter: string;
      try {
        nextAfter = assertU64Decimal(page.nextAfter, 'nextAfter', true);
      } catch (err) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `invalid nextAfter: ${describe(err)}` };
      }
      if (BigInt(nextAfter) <= BigInt(requested)) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: 'paging stalled' };
      }
      if (BigInt(nextAfter) > BigInt(remoteSnap)) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: 'nextAfter exceeds snapshotSequence' };
      }
      cursor = nextAfter;
    }

    return { stage: 'ok', conflicts, stalled, applied, changeSequence: lastCommitted };
  }

  private parseState(raw: unknown): RemoteState {
    if (typeof raw !== 'object' || raw === null) throw new Error('invalid sync state');
    const o = raw as Record<string, unknown>;
    const keyEpoch = assertU64Decimal(String(o.keyEpoch), 'keyEpoch');
    const stateVersion = assertU64Decimal(String(o.stateVersion), 'stateVersion');
    const changeSequence = assertU64Decimal(String(o.changeSequence), 'changeSequence', true);
    return { keyEpoch, stateVersion, changeSequence };
  }

  private parsePage(raw: unknown): PullPage {
    if (typeof raw !== 'object' || raw === null) throw new Error('invalid feed page');
    const o = raw as Record<string, unknown>;
    const snapshotSequence = assertU64Decimal(String(o.snapshotSequence), 'snapshotSequence', true);
    const recordsRaw = o.records;
    if (!Array.isArray(recordsRaw)) throw new Error('invalid feed page records');
    const records: RemoteRecord[] = recordsRaw.map((r) => {
      if (typeof r !== 'object' || r === null) throw new Error('invalid feed record');
      const ro = r as Record<string, unknown>;
      const recordId = assertRecordId(typeof ro.recordId === 'string' ? ro.recordId : '', 'recordId');
      const version = assertU64Decimal(String(ro.version), 'version');
      const changeSequence = assertU64Decimal(String(ro.changeSequence), 'changeSequence', true);
      const deleteTime = ro.deleteTime == null ? null : String(ro.deleteTime);
      const nonce = ro.nonce;
      const ciphertext = ro.ciphertext;
      const tag = ro.tag;
      if (deleteTime == null) {
        if (typeof nonce !== 'string' || nonce === '' ||
          typeof ciphertext !== 'string' || ciphertext === '' ||
          typeof tag !== 'string' || tag === '') {
          throw new Error('active feed record missing nonce/ciphertext/tag');
        }
      }
      return {
        recordId,
        version,
        changeSequence,
        deleteTime,
        nonce: typeof nonce === 'string' ? nonce : undefined,
        ciphertext: typeof ciphertext === 'string' ? ciphertext : undefined,
        tag: typeof tag === 'string' ? tag : undefined,
      };
    });
    return { snapshotSequence, nextAfter: typeof o.nextAfter === 'string' ? o.nextAfter : undefined, records };
  }

  private async pushMutation(m: PendingMutation): Promise<unknown> {
    const keyEpoch = this.deps.keyEpoch;
    if (m.action === 'record.put') {
      return this.deps.client.putRecordSigned({
        keyEpoch,
        mutationId: m.mutationId,
        recordId: m.recordId,
        baseVersion: m.baseVersion,
        signature: m.signature,
        requestDigest: m.requestDigest,
        nonce: m.nonce,
        ciphertext: m.ciphertext,
        tag: m.tag,
      });
    }
    return this.deps.client.deleteRecordSigned({
      keyEpoch,
      mutationId: m.mutationId,
      recordId: m.recordId,
      baseVersion: m.baseVersion,
      signature: m.signature,
      requestDigest: m.requestDigest,
    });
  }

  /** 出站「确认」：成功先回写 recordMap，再（调用方）删 outbox；与入站 applyRecord confirm 对称。 */
  private async confirmOutbound(m: PendingMutation, receipt: unknown): Promise<void> {
    if (m.action === 'record.put') {
      const version = this.parseReceiptVersion(receipt);
      await this.deps.mapStore.put(m.recordId, {
        connectionId: m.connectionId,
        recordVersion: version,
        revision: m.revision,
        status: 'confirmed',
      });
    } else {
      await this.deps.mapStore.deleteByConnectionId(m.connectionId);
    }
  }

  private parseReceiptVersion(receipt: unknown): string {
    if (typeof receipt !== 'object' || receipt === null) throw new Error('invalid record receipt');
    const o = receipt as Record<string, unknown>;
    if (typeof o.version !== 'string') throw new Error('record receipt missing version');
    return assertU64Decimal(o.version, 'receipt.version');
  }

  private async applyRemote(rec: RemoteRecord, keyEpoch: string, ctx: ApplyContext): Promise<void> {
    if (rec.deleteTime != null) {
      await applyRecord({ recordId: rec.recordId, version: rec.version, tombstone: true }, ctx);
      return;
    }
    const dek = this.deps.dek();
    const plaintext = openRecord(
      dek,
      Buffer.from(rec.nonce!, 'base64url'),
      Buffer.from(rec.ciphertext!, 'base64url'),
      Buffer.from(rec.tag!, 'base64url'),
      { userId: this.deps.userId, keyEpoch, recordId: rec.recordId, recordVersion: rec.version },
    );
    await applyRecord(
      { recordId: rec.recordId, version: rec.version, tombstone: false, payload: JSON.parse(Buffer.from(plaintext).toString('utf8')) },
      ctx,
    );
  }

  private async commitCursor(keyEpoch: string, stateVersion: string, changeSequence: string): Promise<void> {
    await this.deps.stateStore.setSnapshot({ keyEpoch, stateVersion, changeSequence });
  }
}