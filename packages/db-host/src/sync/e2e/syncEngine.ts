import { PersonalSyncClient, SyncApiError } from './client.js';
import { openRecord } from './recordCodec.js';
import { applyRecord, reconcileUnresolved, type ApplyContext, type ApplyDisposition } from './applyRecords.js';
import { RecordConflictError } from './errors.js';
import type { RecordMapStore } from './recordMapStore.js';
import type { DeferredRecordStore } from './deferredRecordStore.js';
import { PendingMutationStore, type PendingMutation } from './pendingMutationStore.js';
import type { StateStore } from './stateStore.js';
import { EntityStore, UnresolvedRefStore, applyOrder } from './entityStore.js';
import type { CachedEntitlement } from '../entitlementGate.js';
import { assertRecordId, assertBase64UrlNoPad, assertBase64UrlRange, assertU64Decimal, rejectExtraKeys, validateSyncState } from './types.js';

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

/** 同步分相：`both` 先 push 后 pull（默认）；`push` 仅出站；`pull` 仅入站。 */
export type SyncPhase = 'both' | 'push' | 'pull';

/** 同步进行中的进度快照（供状态栏显示"进行中 + 条数"；无百分比，feed 不含总量）。 */
export interface SyncProgress {
  phase: SyncPhase;
  /** 入站已处理记录数。 */
  applied: number;
  /** 入站真实落地数（created/updated/deleted）。 */
  changes: number;
  /** 出站已成功推送数。 */
  pushed: number;
  /** 已拉取的 feed 页数。 */
  pages: number;
}

export interface SyncConflictEntry {
  recordId: string;
  kind: 'version' | 'pending';
  code?: string;
  currentVersion?: string;
  /** 远端密文（入站冲突时携带，供 Use Remote 直接解密应用）。 */
  remoteNonce?: string;
  remoteCiphertext?: string;
  remoteTag?: string;
  remoteVersion?: string;
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
  /** 入站真正落地（created/updated/deleted）的记录数——区别于 `applied`（处理的记录数）。 */
  changes?: number;
  /** 入站墓碑因本地无映射被忽略（`ignored-tombstone`）的记录数。 */
  ignoredTombstone?: number;
  /** 入站因远端版本不新而跳过（`skipped`，版本重放）的记录数。 */
  skippedRemote?: number;
  /** 出站成功推送（confirm + 删除 outbox）的本地变更数（push 轮）。 */
  pushed?: number;
  /** 入站因权益（引擎不在套餐）被跳过、进 deferred 的记录数。 */
  skippedEntitlement?: number;
  /** 入站因引擎本客户端不支持（如未来新增引擎）被跳过、进 deferred 的记录数（H3 向前兼容）。 */
  skippedUnsupported?: number;
  /** 出站因编码失败/引擎不支持被跳过的本地变更数（由 coordinator 从 reconcile 结果补入）。 */
  skippedOutbound?: number;
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
const MAX_RECORD_CIPHERTEXT_BYTES = 256 * 1024;

/** 协议不匹配 / 畸形 feed 输入：fail-closed，标记为 terminal 终止本轮（重试无意义）。 */
class FeedProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedProtocolError';
  }
}

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
  entities: EntityStore;
  unresolved: UnresolvedRefStore;
  /** 被权益门禁跳过的入站记录（升级后重放）；缺省则不 defer（旧调用方兼容）。 */
  deferred?: DeferredRecordStore;
  /** DEK 数据加密密钥（解密 feed record）。 */
  dek: () => Uint8Array;
  /** 仅供任务 3「本地变更→mutation」首次签名；本轮 outbox 重放不调用。 */
  signSeed: () => Uint8Array;
  /** B4 pending 冲突：无既有 outbox 条目时，用它构造一个 conflict carrier（复用 rebase 签名）。 */
  seedConflictCarrier: (recordId: string, ref: import('./syncEntity').SyncEntityRef, baseVersion: string) => PendingMutation;
  uniqueId: (type: import('./syncEntity').SyncEntityType) => string;
  entitlement?: () => CachedEntitlement | undefined;
  feedPageLimit?: number;
  /** P6：某条 put 推送成功并确认映射后回调（用于清除本地“未同步”标记）。 */
  onEntityPushed?: (ref: import('./syncEntity').SyncEntityRef) => void | Promise<void>;
  /** P6：按类型配额拒绝（终态）时回调该记录对应本地实体（用于标 localOnly/syncError）。 */
  onQuotaRejected?: (ref: import('./syncEntity').SyncEntityRef) => void | Promise<void>;
  /** 进行中进度回调（状态栏用）；回调异常应自行吞掉，不得影响同步。 */
  onProgress?: (p: SyncProgress) => void;
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
    return this.syncPhase('both');
  }

  /** 分相同步：`push` 仅重放出站 outbox；`pull` 仅拉取 feed；`both` 先 push 后 pull。 */
  /** 进度回调（异常吞掉，绝不影响同步）。 */
  private emitProgress(p: SyncProgress): void {
    try { this.deps.onProgress?.(p); } catch { /* 进度回调异常不影响同步 */ }
  }

  syncPhase(phase: SyncPhase): Promise<SyncRunResult> {
    if (this.inflight) return this.inflight;
    const p = this.run(phase);
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

  private async run(phase: SyncPhase = 'both'): Promise<SyncRunResult> {
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
    const conflicts: SyncConflictEntry[] = [];
    let stalled: SyncStalledEntry | undefined;
    let lastCommitted = local.changeSequence;
    let pushed = 0;
    for (const m of (phase === 'pull' ? [] : this.deps.outbox.list())) {
      // C1：已标记冲突的 mutation 不得再 push（避免每轮重复 409）；把持久化冲突反馈给 UI。
      if (m.conflict) {
        conflicts.push({
          recordId: m.recordId,
          kind: m.conflict.kind,
          currentVersion: m.conflict.currentVersion,
          remoteNonce: m.conflict.remoteNonce,
          remoteCiphertext: m.conflict.remoteCiphertext,
          remoteTag: m.conflict.remoteTag,
          remoteVersion: m.conflict.remoteRecordVersion,
        });
        continue;
      }
      let receipt: unknown;
      try {
        receipt = await this.pushMutation(m);
      } catch (err) {
        if (err instanceof SyncApiError) {
          const cls = classifyError(err);
          if (cls === 'terminal' || cls === 'terminal-state' || cls === 'terminal-epoch') {
            if (err.code === 'SYNC_QUOTA_EXCEEDED') {
              // P6 §六：按类型配额拒绝 → 标记本地实体 localOnly/quota（不静默循环；终态已停重试）。
              try { await this.deps.onQuotaRejected?.({ type: m.type, localId: m.localId }); } catch { /* 回调失败不改变终态 */ }
            }
            return {
              stage: 'terminal', conflicts, applied: 0,
              terminal: { mutationId: m.mutationId, code: err.code, currentKeyEpoch: err.currentKeyEpoch },
              reason: cls === 'terminal-state'
                ? 'outbox mutation requires init / epoch handling'
                : cls === 'terminal-epoch' ? 'outbox mutation epoch stale' : undefined,
            };
          }
          // B4：持久化冲突（密文暂缺），跳过 push 继续 pull —— pull 会带回远端版本，
          // applyRemote 再次触发 RecordConflictError 时补全密文（见下方入站冲突）。
          if (cls === 'conflict') {
            // SYNC_VERSION_CONFLICT 必须携带规范 u64 currentVersion；缺失/非法即协议违规，
            // fail-closed 返回 terminal，不得退回可重试（否则既无法构造冲突也无从 rebase）。
            let currentVersion: string;
            try {
              if (typeof err.currentVersion !== 'string') throw new Error('missing');
              currentVersion = assertU64Decimal(err.currentVersion, 'currentVersion');
            } catch {
              return {
                stage: 'terminal', conflicts, applied: 0,
                terminal: { mutationId: m.mutationId, code: err.code },
                reason: 'malformed SYNC_VERSION_CONFLICT (missing/invalid currentVersion)',
              };
            }
            conflicts.push({ recordId: m.recordId, kind: 'version', code: err.code, currentVersion });
            await this.deps.outbox.setConflict(m.mutationId, {
              kind: 'version',
              currentVersion,
              remoteRecordVersion: currentVersion,
            });
            continue;
          }
          // 可重试 error：递增连续失败计数；1–4 中止本轮，≥5 保留条目、附 stalled、允许继续 pull。
          const nextCount = m.consecutiveFailureCount + 1;
          try {
            await this.deps.outbox.setFailureCount(m.mutationId, nextCount);
          } catch (err) {
            return { stage: 'error', conflicts, applied: 0, reason: `failure-count commit failed: ${describe(err)}` };
          }
          if (nextCount >= STALL_THRESHOLD) {
            stalled = { mutationId: m.mutationId };
            break;
          }
          // 已收集到冲突时以 conflict 收尾（不被 push 错误盖掉），确保冲突面板弹出、不静默。
          return {
            stage: conflicts.length > 0 ? 'conflict' : 'error',
            conflicts, applied: 0, pushed, changeSequence: lastCommitted,
            reason: `push failed: ${describe(err)}`,
          };
        }
        return {
          stage: conflicts.length > 0 ? 'conflict' : 'error',
          conflicts, applied: 0, pushed, changeSequence: lastCommitted,
          reason: `push failed: ${describe(err)}`,
        };
      }

      let confirmed: { version: string; changeSequence: string };
      try {
        confirmed = this.parseReceipt(receipt);
      } catch (err) {
        return { stage: 'error', conflicts, applied: 0, reason: `invalid receipt: ${describe(err)}` };
      }
      try {
        await this.confirmOutbound(m, confirmed.version);
      } catch (err) {
        return { stage: 'error', conflicts, applied: 0, reason: `confirm failed: ${describe(err)}` };
      }
      await this.deps.outbox.delete(m.mutationId);
      pushed += 1;
      this.emitProgress({ phase, applied: 0, changes: 0, pushed, pages: 0 });
      // 刻意不用 receipt.changeSequence 推进本地 cursor：本轮 pull 快照（remoteSnap）在
      // outbox 回放之前捕获，若存在并发 remote record 落于其上，直接提交回执序列会永久
      // 越过该记录（下轮 cursor 已越过其 seq，无法再拉）。cursor 仅由 pull 逐页提交推进，
      // 本轮未拉到的 push record 由下轮幂等重放收敛。
    }

    // push-only：出站重放完成即返回，不进入 feed 拉取。
    if (phase === 'push') {
      this.emitProgress({ phase, applied: 0, changes: 0, pushed, pages: 0 });
      return { stage: conflicts.length > 0 ? 'conflict' : 'ok', conflicts, stalled, applied: 0, pushed, changeSequence: lastCommitted };
    }

    // 3. 分页 feed + 解密 + 应用 + 逐页 cursor
    const remoteSnap = remoteState.changeSequence;
    const ctx: ApplyContext = {
      entities: this.deps.entities,
      mapStore: this.deps.mapStore,
      unresolved: this.deps.unresolved,
      entitlement: this.deps.entitlement?.(),
      uniqueId: this.deps.uniqueId,
    };

    let cursor = local.changeSequence;
    let applied = 0;
    let skippedEntitlement = 0;
    let skippedUnsupported = 0;
    // 落地/忽略/跳过计数：让 UI 与诊断能区分「真变更」与「处理了但没变」。
    let changes = 0;
    let ignoredTombstone = 0;
    let skippedRemote = 0;

    // 先重放上一轮被权益跳过的记录：升级后无需重拉即可落地。
    try {
      applied += await this.drainDeferred(ctx, conflicts);
    } catch (err) {
      return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `deferred drain failed: ${describe(err)}` };
    }
    // drain 可能把此前"引用被延迟"的连接落地；立即收敛 unresolved，
    // 否则升级后若 feed 为空（常见），依赖方（查询/文件夹）的 connId 会一直解析不了。
    try {
      await reconcileUnresolved(ctx);
    } catch (err) {
      return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `reconcile unresolved failed: ${describe(err)}` };
    }

    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: 'paging exceeded limit' };
      }
      const requested = cursor;
      let page: PullPage;
      try {
        page = this.parsePage(await this.deps.client.getRecords(requested, remoteSnap, limit));
      } catch (err) {
        if (err instanceof FeedProtocolError) {
          return { stage: 'terminal', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `feed protocol unsupported: ${describe(err)}` };
        }
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `pull failed: ${describe(err)}` };
      }
      if (page.snapshotSequence !== remoteSnap) {
        return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: 'snapshotSequence drift' };
      }

      if (page.records.length > 0) {
        // 先解密得到 type，按 applyOrder 排序后应用，保证批内引用先于被依赖者到达时立即翻译（N2）。
        // 解密失败（含 lock 后 thunk throw）归入结构化 error，不使 sync() 整体 reject。
        let typed: { rec: RemoteRecord; type: import('./syncEntity').SyncEntityType }[];
        try {
          typed = page.records.map((rec) => ({ rec, type: this.typeOfRemote(rec) }));
        } catch (err) {
          return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `apply failed: ${describe(err)}` };
        }
        typed.sort((a, b) => applyOrder(a.type) - applyOrder(b.type));
        for (const { rec } of typed) {
          try {
            const disposition = await this.applyRemote(rec, this.deps.keyEpoch, ctx);
            // 权益跳过一律入 deferred（无论是否已映射）；版本重放的 'skipped' 不入队。
            // 计数与 deferred 解耦：即便未注入 deferred，跳过也要计入透明度字段，避免静默吞掉。
            if (disposition === 'created' || disposition === 'updated' || disposition === 'deleted') changes += 1;
            else if (disposition === 'ignored-tombstone') ignoredTombstone += 1;
            else if (disposition === 'skipped') skippedRemote += 1;
            if (disposition === 'skipped-entitlement' || disposition === 'skipped-unsupported') {
              if (disposition === 'skipped-entitlement') skippedEntitlement += 1;
              else skippedUnsupported += 1;
              // 未知引擎同样入 deferred：未来客户端支持后无需重拉即可重放。
              if (this.deps.deferred) {
                await this.deps.deferred.put({
                  recordId: rec.recordId,
                  version: rec.version,
                  changeSequence: rec.changeSequence,
                  deleteTime: rec.deleteTime,
                  nonce: rec.nonce,
                  ciphertext: rec.ciphertext,
                  tag: rec.tag,
                });
              }
            }
            // 远端墓碑落地/忽略后，清掉 deferred 里同一 recordId 的旧密文：
            // 否则升级/权益放开后会拿旧密文把已删除的记录重新 drain 回来（复活 bug）。
            if (rec.deleteTime != null && (disposition === 'ignored-tombstone' || disposition === 'deleted')) {
              try { await this.deps.deferred?.delete(rec.recordId); } catch { /* 清 deferred 失败不阻断本页 */ }
            }
            applied += 1; // 注：applied 含 skipped-entitlement（版本重放的 skipped 不计）；UI 仅用 skipped* 计数。
          } catch (err) {
            if (err instanceof RecordConflictError) {
              // B4：携带远端密文进冲突条目，并补全 outbox 中对应 mutation 的冲突状态。
              conflicts.push({
                recordId: rec.recordId,
                kind: err.kind,
                remoteNonce: rec.nonce,
                remoteCiphertext: rec.ciphertext,
                remoteTag: rec.tag,
                remoteVersion: rec.version,
              });
              await this.persistConflict(rec, err);
              return { stage: 'conflict', conflicts, stalled, applied, changes, ignoredTombstone, skippedRemote, skippedEntitlement, skippedUnsupported, changeSequence: lastCommitted };
            }
            return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `apply failed: ${describe(err)}` };
          }
        }
        // 页内全部应用后收敛 unresolved 引用（引用方可能落在被依赖者之前到达的后续页）。
        try {
          await reconcileUnresolved(ctx);
        } catch (err) {
          return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `reconcile unresolved failed: ${describe(err)}` };
        }
        const lastSeq = page.records[page.records.length - 1].changeSequence;
        try {
          await this.commitCursor(remoteState.keyEpoch, remoteState.stateVersion, lastSeq);
          lastCommitted = lastSeq;
        } catch (err) {
          return { stage: 'error', conflicts, stalled, applied, changeSequence: lastCommitted, reason: `cursor commit failed: ${describe(err)}` };
        }
        this.emitProgress({ phase, applied, changes, pushed, pages: pages + 1 });
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

    // C2：本轮收集到冲突（出站 version 冲突未在本轮 pull 命中远端时仍属冲突）→ 以 conflict 收尾，
    // 让 coordinator 进入 stalled，不再自动重放同一条冲突 mutation。
    return { stage: conflicts.length > 0 ? 'conflict' : 'ok', conflicts, stalled, applied, pushed, changes, ignoredTombstone, skippedRemote, skippedEntitlement, skippedUnsupported, changeSequence: lastCommitted };
  }

  private parseState(raw: unknown): RemoteState {
    const s = validateSyncState(raw);
    return { keyEpoch: s.keyEpoch, stateVersion: s.stateVersion, changeSequence: s.changeSequence };
  }

  private parsePage(raw: unknown): PullPage {
    if (typeof raw !== 'object' || raw === null) throw new FeedProtocolError('invalid feed page');
    const o = raw as Record<string, unknown>;
    rejectExtraKeys(o, ['snapshotSequence', 'nextAfter', 'records'], 'feed page');
    const snapshotSequence = this.readU64(o, 'snapshotSequence', true);
    const recordsRaw = o.records;
    if (!Array.isArray(recordsRaw)) throw new FeedProtocolError('invalid feed page records');
    const records: RemoteRecord[] = recordsRaw.map((r) => {
      if (typeof r !== 'object' || r === null) throw new FeedProtocolError('invalid feed record');
      const ro = r as Record<string, unknown>;
      rejectExtraKeys(ro, ['recordId', 'version', 'changeSequence', 'deleteTime', 'cipherSuite', 'formatVersion', 'nonce', 'ciphertext', 'tag', 'updateTime'], 'feed record');
      const recordId = assertRecordId(typeof ro.recordId === 'string' ? ro.recordId : '', 'recordId');
      const version = this.readU64(ro, 'version');
      const changeSequence = this.readU64(ro, 'changeSequence', true);
      const deleteTime = ro.deleteTime == null ? null : String(ro.deleteTime);
      if (deleteTime == null) {
        // active：cipherSuite/formatVersion 必须匹配，nonce/tag/ciphertext 严格校验
        if (ro.cipherSuite !== 'AES-256-GCM' || ro.formatVersion !== 1) {
          throw new FeedProtocolError('feed record cipherSuite/formatVersion unsupported');
        }
        const nonce = this.readB64(ro, 'nonce', 12);
        const ciphertext = this.readB64Range(ro, 'ciphertext', 1, MAX_RECORD_CIPHERTEXT_BYTES);
        const tag = this.readB64(ro, 'tag', 16);
        return { recordId, version, changeSequence, deleteTime, nonce, ciphertext, tag };
      }
      // tombstone：不得携带密文字段
      if (ro.nonce !== undefined || ro.ciphertext !== undefined || ro.tag !== undefined) {
        throw new FeedProtocolError('tombstone feed record must not carry nonce/ciphertext/tag');
      }
      return { recordId, version, changeSequence, deleteTime };
    });
    // nextAfter 缺省 = 已是最后一页；但若字段存在却不是字符串，说明页面契约被破坏，
    // 静默当作"结束"会悄悄漏掉后续记录，必须 fail-closed。
    if (o.nextAfter !== undefined && typeof o.nextAfter !== 'string') {
      throw new FeedProtocolError('nextAfter must be a string');
    }
    return { snapshotSequence, nextAfter: o.nextAfter, records };
  }

  private readU64(o: Record<string, unknown>, key: string, allowZero = false): string {
    const v = o[key];
    if (typeof v !== 'string') throw new FeedProtocolError(`${key} must be a string`);
    return assertU64Decimal(v, key, allowZero);
  }

  private readB64(o: Record<string, unknown>, key: string, len: number): string {
    const v = o[key];
    if (typeof v !== 'string') throw new FeedProtocolError(`${key} must be a string`);
    assertBase64UrlNoPad(v, len, key);
    return v;
  }

  private readB64Range(o: Record<string, unknown>, key: string, min: number, max: number): string {
    const v = o[key];
    if (typeof v !== 'string') throw new FeedProtocolError(`${key} must be a string`);
    assertBase64UrlRange(v, min, max, key);
    return v;
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
  private async confirmOutbound(m: PendingMutation, version: string): Promise<void> {
    if (m.action === 'record.put') {
      await this.deps.mapStore.put(m.recordId, {
        type: m.type,
        localId: m.localId,
        recordVersion: version,
        revision: m.revision,
        status: 'confirmed',
      });
      try { await this.deps.onEntityPushed?.({ type: m.type, localId: m.localId }); } catch { /* 回调失败不影响确认 */ }
    } else {
      await this.deps.mapStore.deleteByRef({ type: m.type, localId: m.localId });
    }
  }

  private parseReceipt(receipt: unknown): { version: string; changeSequence: string } {
    if (typeof receipt !== 'object' || receipt === null) throw new Error('invalid record receipt');
    const o = receipt as Record<string, unknown>;
    if (typeof o.version !== 'string') throw new Error('record receipt missing version');
    if (typeof o.changeSequence !== 'string') throw new Error('record receipt missing changeSequence');
    return {
      version: assertU64Decimal(o.version, 'receipt.version'),
      changeSequence: assertU64Decimal(o.changeSequence, 'receipt.changeSequence', true),
    };
  }

  /** 提前解密得到实体 type（tombstone 由映射反查），供应用前拓扑排序。 */
  private typeOfRemote(rec: RemoteRecord): import('./syncEntity').SyncEntityType {
    if (rec.deleteTime != null) {
      const existing = this.deps.mapStore.getByRecordId(rec.recordId);
      return existing?.type ?? 'connection';
    }
    const dek = this.deps.dek();
    const plaintext = openRecord(
      dek,
      Buffer.from(rec.nonce!, 'base64url'),
      Buffer.from(rec.ciphertext!, 'base64url'),
      Buffer.from(rec.tag!, 'base64url'),
      { userId: this.deps.userId, keyEpoch: this.deps.keyEpoch, recordId: rec.recordId, recordVersion: rec.version },
    );
    const payload = JSON.parse(Buffer.from(plaintext).toString('utf8')) as { type?: unknown };
    if (payload.type === 'connection' || payload.type === 'group' || payload.type === 'queryFolder' || payload.type === 'query'
      || payload.type === 'authenticatorEntry' || payload.type === 'authenticatorGroup' || payload.type === 'authenticatorTag') {
      return payload.type;
    }
    throw new FeedProtocolError('record payload missing valid type');
  }

  private async applyRemote(rec: RemoteRecord, keyEpoch: string, ctx: ApplyContext): Promise<ApplyDisposition> {
    if (rec.deleteTime != null) {
      return (await applyRecord({ recordId: rec.recordId, version: rec.version, tombstone: true }, ctx)).disposition;
    }
    const dek = this.deps.dek();
    const plaintext = openRecord(
      dek,
      Buffer.from(rec.nonce!, 'base64url'),
      Buffer.from(rec.ciphertext!, 'base64url'),
      Buffer.from(rec.tag!, 'base64url'),
      { userId: this.deps.userId, keyEpoch, recordId: rec.recordId, recordVersion: rec.version },
    );
    return (await applyRecord(
      { recordId: rec.recordId, version: rec.version, tombstone: false, payload: JSON.parse(Buffer.from(plaintext).toString('utf8')) },
      ctx,
    )).disposition;
  }

  /**
   * 重放上一轮因权益被跳过的记录：权益放开后落地并移除；仍被拒则保留。
   * 冲突并入本轮回 conflicts（不吞掉用户可见冲突）；解密/写盘等错误**保留条目**重试，
   * 不再静默丢弃（游标已越过，删掉即永久丢失）。
   */
  private async drainDeferred(ctx: ApplyContext, conflicts: SyncConflictEntry[]): Promise<number> {
    const deferred = this.deps.deferred;
    if (!deferred) return 0;
    let drained = 0;
    for (const entry of deferred.list()) {
      const rec: RemoteRecord = {
        recordId: entry.recordId,
        version: entry.version,
        changeSequence: entry.changeSequence,
        deleteTime: entry.deleteTime,
        nonce: entry.nonce,
        ciphertext: entry.ciphertext,
        tag: entry.tag,
      };
      try {
        const disposition = await this.applyRemote(rec, this.deps.keyEpoch, ctx);
        // 仍无权益 / 仍不支持该引擎：保留待下次（未来支持后可重放）。
        if (disposition === 'skipped-entitlement' || disposition === 'skipped-unsupported') continue;
        await deferred.delete(entry.recordId);
        drained += 1;
      } catch (err) {
        if (err instanceof RecordConflictError) {
          conflicts.push({
            recordId: rec.recordId,
            kind: err.kind,
            remoteNonce: rec.nonce,
            remoteCiphertext: rec.ciphertext,
            remoteTag: rec.tag,
            remoteVersion: rec.version,
          });
          try {
            await this.persistConflict(rec, err);
          } catch {
            /* best-effort */
          }
          // 冲突已并入本轮回 conflicts，删除条目避免每轮重复。
          await deferred.delete(entry.recordId).catch(() => {});
        }
        // 其他错误（解密、写盘等）：保留条目，不静默丢弃 —— 记录入队时游标已越过，
        // 删掉就永久丢失；下次同步重试，条目上限（1000）兜底增长。
      }
    }
    return drained;
  }

  private async commitCursor(keyEpoch: string, stateVersion: string, changeSequence: string): Promise<void> {
    await this.deps.stateStore.setSnapshot({ keyEpoch, stateVersion, changeSequence });
  }

  /** B4：入站冲突时，按 recordId→recordMap→localId 定位 outbox 条目并补全冲突密文。 */
  private async persistConflict(rec: RemoteRecord, err: RecordConflictError): Promise<void> {
    const mapEntry = this.deps.mapStore.getByRecordId(rec.recordId);
    if (!mapEntry) return; // 无法定位本地实体，仅本轮内存呈现
    const conflict = {
      kind: err.kind,
      currentVersion: rec.version,
      remoteRecordVersion: rec.version,
      remoteNonce: rec.nonce,
      remoteCiphertext: rec.ciphertext,
      remoteTag: rec.tag,
      remoteTombstone: rec.deleteTime != null,
    };
    const mutation = this.deps.outbox.list().find((m) => m.type === mapEntry.type && m.localId === mapEntry.localId);
    if (mutation) {
      await this.deps.outbox.setConflict(mutation.mutationId, conflict);
      return;
    }
    // 无既有 outbox 条目（pending 冲突：reconcile 对 pending map 跳过，不产 mutation）：
    // 构造 conflict carrier 使其可被 listConflicts()/resolveConflict() 发现并处理。
    const carrier = this.deps.seedConflictCarrier(rec.recordId, { type: mapEntry.type, localId: mapEntry.localId }, rec.version);
    await this.deps.outbox.put({ ...carrier, conflict });
  }
}