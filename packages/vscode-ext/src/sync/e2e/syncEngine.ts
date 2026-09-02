import { PersonalSyncClient, SyncApiError } from './client';
import { openRecord } from './recordCodec';
import { applyRecord, type ApplyDisposition } from './applyRecords';
import { RecordConflictError } from './errors';
import type { RecordMapStore } from './recordMapStore';
import { PendingMutationStore, type PendingMutation } from './pendingMutationStore';
import type { StateStore } from './stateStore';
import type { ConnectionStore } from '../../connection/connectionStore';
import type { CachedEntitlement } from '../authService';
import { assertU64Decimal } from './types';

/**
 * 个人同步运行循环（SyncEngine）。
 *
 * 只负责「已初始化、已持有 DEK」状态下的单轮同步，不持有密钥生命周期、不做 UI、不接
 * 连接变更监听（归任务 3/4/5）。并发调用单飞合并；一轮内固定顺序：
 *
 *   epoch 对账 → outbox 重放/推 mutation → 分页 feed → 解密 + 安全应用 → 保存 cursor
 *
 * 失败语义：
 * - epoch 不匹配（远端 keyEpoch > 本地）→ 停止、stage='epoch-mismatch'，不重试不覆盖。
 * - outbox 重放网络失败/5xx → 保留 outbox 原样，本轮中止；下轮重演同 mutationId。
 * - 同 mutationId 异 digest（409 CONFLICT）→ 永久错误，标记 terminal，不重推不静默删。
 * - 应用遇 RecordConflictError → 停在该 record、cursor 停在最后确认页，交 UI（任务 4）。
 */

export type SyncRunStage = 'ok' | 'epoch-mismatch' | 'conflict' | 'error' | 'terminal';

export interface SyncConflictEntry {
  recordId: string;
  kind: 'version' | 'pending';
}

export interface SyncRunResult {
  stage: SyncRunStage;
  conflicts: SyncConflictEntry[];
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

export interface SyncEngineDeps {
  userId: string;
  client: PersonalSyncClient;
  stateStore: StateStore;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  store: ConnectionStore;
  /** DEK 数据加密密钥（解密 feed record；同时由调用方派生签名 seed）。 */
  dek: () => Uint8Array;
  /** 签名 seed（由 DEK 经 HKDF 派生），供 put/delete record 签名。 */
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

  constructor(private readonly deps: SyncEngineDeps) {}

  /** 单飞：并发 sync() 合并进同一轮，失败后清空允许下次重试。 */
  sync(): Promise<SyncRunResult> {
    if (this.inflight) return this.inflight;
    const p = this.run();
    this.inflight = p;
    void p.finally(() => {
      if (this.inflight === p) this.inflight = undefined;
    });
    return p;
  }

  private async run(): Promise<SyncRunResult> {
    const limit = this.deps.feedPageLimit ?? 256;

    // 1. epoch 对账
    let remoteState: RemoteState;
    try {
      const raw = await this.deps.client.getState();
      remoteState = this.parseState(raw);
    } catch (err) {
      return { stage: 'error', conflicts: [], applied: 0, reason: `getState failed: ${describe(err)}` };
    }

    const local = this.deps.stateStore.getSnapshot();
    if (!local) {
      return { stage: 'epoch-mismatch', conflicts: [], applied: 0, reason: 'no local sync state (init required)' };
    }
    if (BigInt(remoteState.keyEpoch) !== BigInt(local.keyEpoch)) {
      return { stage: 'epoch-mismatch', conflicts: [], applied: 0, reason: 'remote keyEpoch differs from local' };
    }

    // 2. outbox 重放：逐条按原样字段 push（§7.4），成功删 outbox。
    for (const m of this.deps.outbox.list()) {
      try {
        await this.pushMutation(m);
        await this.deps.outbox.delete(m.mutationId);
      } catch (err) {
        if (err instanceof SyncApiError && err.status < 500) {
          // 4xx 永久错误（CONFLICT / SYNC_PROTOCOL_UNSUPPORTED / 签名无效等）：terminal，不重推不静默删。
          return { stage: 'terminal', conflicts: [], applied: 0, reason: `outbox push rejected: ${describe(err)}` };
        }
        // 网络/5xx：保留 outbox 原样，本轮中止，下轮重演同 mutationId。
        return { stage: 'error', conflicts: [], applied: 0, reason: `push failed: ${describe(err)}` };
      }
    }

    // 3. 分页 pull + 解密 + 应用 + 逐页 cursor
    let after = local.changeSequence;
    let applied = 0;
    const conflicts: SyncConflictEntry[] = [];
    const ctx = {
      store: this.deps.store,
      mapStore: this.deps.mapStore,
      entitlement: this.deps.entitlement?.(),
      uniqueConnectionId: this.deps.uniqueConnectionId,
    };

    for (;;) {
      let page: PullPage;
      try {
        const raw = await this.deps.client.getRecords(after, remoteState.changeSequence, limit);
        page = this.parsePage(raw);
      } catch (err) {
        return { stage: 'error', conflicts, applied, reason: `pull failed: ${describe(err)}` };
      }

      let pageLast: string | undefined;
      for (const rec of page.records) {
        try {
          await this.applyRemote(rec, remoteState.keyEpoch, ctx);
          applied += 1;
          pageLast = rec.changeSequence;
        } catch (err) {
          if (err instanceof RecordConflictError) {
            conflicts.push({ recordId: rec.recordId, kind: err.kind });
            // 停在该 record，cursor 不前移；后续 record 本轮不处理。
            return { stage: 'conflict', conflicts, applied, changeSequence: after, reason: `conflict at ${rec.recordId}` };
          }
          return { stage: 'error', conflicts, applied, changeSequence: after, reason: `apply failed: ${describe(err)}` };
        }
      }

      // 该页全部成功：推进本地 cursor 到该页最后一条 changeSequence。
      if (pageLast !== undefined) {
        after = pageLast;
        await this.commitCursor(remoteState.keyEpoch, remoteState.stateVersion, pageLast);
      }

      if (!page.nextAfter) break;
      after = page.nextAfter;
    }

    return { stage: 'ok', conflicts, applied, changeSequence: after };
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
      return {
        recordId: String(ro.recordId),
        version: assertU64Decimal(String(ro.version), 'version'),
        changeSequence: assertU64Decimal(String(ro.changeSequence), 'changeSequence', true),
        deleteTime: ro.deleteTime == null ? null : String(ro.deleteTime),
        nonce: typeof ro.nonce === 'string' ? ro.nonce : undefined,
        ciphertext: typeof ro.ciphertext === 'string' ? ro.ciphertext : undefined,
        tag: typeof ro.tag === 'string' ? ro.tag : undefined,
      };
    });
    const nextAfter = typeof o.nextAfter === 'string' ? o.nextAfter : undefined;
    return { snapshotSequence, nextAfter, records };
  }

  private async pushMutation(m: PendingMutation): Promise<void> {
    const seed = this.deps.signSeed();
    if (m.action === 'record.put') {
      await this.deps.client.putRecord({
        userId: this.deps.userId,
        keyEpoch: this.deps.stateStore.getSnapshot()!.keyEpoch,
        mutationId: m.mutationId,
        seed,
        recordId: m.recordId,
        baseVersion: m.baseVersion,
        nonce: m.nonce,
        ciphertext: m.ciphertext,
        tag: m.tag,
      });
    } else {
      await this.deps.client.deleteRecord({
        userId: this.deps.userId,
        keyEpoch: this.deps.stateStore.getSnapshot()!.keyEpoch,
        mutationId: m.mutationId,
        seed,
        recordId: m.recordId,
        baseVersion: m.baseVersion,
      });
    }
  }

  private async applyRemote(rec: RemoteRecord, keyEpoch: string, ctx: Parameters<typeof applyRecord>[1]): Promise<{ disposition: ApplyDisposition }> {
    if (rec.deleteTime != null) {
      return applyRecord({ recordId: rec.recordId, version: rec.version, tombstone: true }, ctx);
    }
    const dek = this.deps.dek();
    const nonce = rec.nonce ?? '';
    const ciphertext = rec.ciphertext ?? '';
    const tag = rec.tag ?? '';
    const plaintext = openRecord(
      dek,
      Buffer.from(nonce, 'base64url'),
      Buffer.from(ciphertext, 'base64url'),
      Buffer.from(tag, 'base64url'),
      { userId: this.deps.userId, keyEpoch, recordId: rec.recordId, recordVersion: rec.version },
    );
    const payload = JSON.parse(Buffer.from(plaintext).toString('utf8')) as unknown;
    return applyRecord({ recordId: rec.recordId, version: rec.version, tombstone: false, payload }, ctx);
  }

  private async commitCursor(keyEpoch: string, stateVersion: string, changeSequence: string): Promise<void> {
    await this.deps.stateStore.setSnapshot({ keyEpoch, stateVersion, changeSequence });
  }
}