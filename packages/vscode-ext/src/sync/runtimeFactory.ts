import { SyncEngine, type SyncRunResult } from './e2e/syncEngine';
import { SyncMutator } from './e2e/syncMutator';
import { SyncCoordinator } from './e2e/syncCoordinator';
import { ConflictResolver } from './e2e/conflictResolver';
import type { PersonalSyncClient } from './e2e/client';
import type { StateStore } from './e2e/stateStore';
import type { RecordMapStore } from './e2e/recordMapStore';
import type { PendingMutationStore } from './e2e/pendingMutationStore';
import type { EntityStore, UnresolvedRefStore } from './e2e/entityStore';
import type { SyncEntityType } from './e2e/syncEntity';
import type { ConnectionStore } from '../connection/connectionStore';
import type { CachedEntitlement } from './authService';

export interface SyncRuntime {
  mutator: SyncMutator;
  engine: SyncEngine;
  coordinator: SyncCoordinator;
  resolver: ConflictResolver;
}

export interface BuildSyncRuntimeDeps {
  userId: string;
  keyEpoch: string;
  client: PersonalSyncClient;
  stateStore: StateStore;
  mapStore: RecordMapStore;
  outbox: PendingMutationStore;
  unresolved: UnresolvedRefStore;
  entities: EntityStore;
  store: ConnectionStore;
  /** 内存 DEK / signSeed 取值器（未解锁时抛出，由会话负责零化与生命周期）。 */
  dek: () => Uint8Array;
  signSeed: () => Uint8Array;
  /** 生成本地实体 id（连接可注入稳定 id）。 */
  uniqueId: (type: SyncEntityType) => string;
  entitlement?: () => CachedEntitlement | undefined;
  onSettled?: (result: SyncRunResult | undefined) => void;
}

/**
 * 构造单个 epoch 的同步运行组件（mutator/engine/coordinator/resolver）。
 *
 * 自 PersonalSyncSession.unlock() 抽出：会话只负责「是否已构造」与生命周期
 * （start/stop、零化密钥），装配细节集中此处，便于单独审阅与测试。
 */
export function buildSyncRuntime(deps: BuildSyncRuntimeDeps): SyncRuntime {
  const mutator = new SyncMutator({
    userId: deps.userId,
    keyEpoch: deps.keyEpoch,
    entities: deps.entities,
    mapStore: deps.mapStore,
    outbox: deps.outbox,
    dek: deps.dek,
    signSeed: deps.signSeed,
  });
  const engine = new SyncEngine({
    userId: deps.userId,
    keyEpoch: deps.keyEpoch,
    client: deps.client,
    stateStore: deps.stateStore,
    mapStore: deps.mapStore,
    outbox: deps.outbox,
    entities: deps.entities,
    unresolved: deps.unresolved,
    dek: deps.dek,
    signSeed: deps.signSeed,
    uniqueId: deps.uniqueId,
    entitlement: deps.entitlement,
    seedConflictCarrier: (recordId, ref, baseVersion) => mutator.rebasePut(recordId, ref, baseVersion),
  });
  const coordinator = new SyncCoordinator(deps.store, mutator, engine, {
    onSettled: deps.onSettled,
  });
  const resolver = new ConflictResolver({
    userId: deps.userId,
    keyEpoch: deps.keyEpoch,
    mapStore: deps.mapStore,
    outbox: deps.outbox,
    entities: deps.entities,
    unresolved: deps.unresolved,
    dek: deps.dek,
    mutator,
    entitlement: deps.entitlement,
    uniqueId: deps.uniqueId,
  });
  return { mutator, engine, coordinator, resolver };
}