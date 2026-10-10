import type { SavedConnection, ConnectionGroup } from '../../connection/connectionStore.js';
import type { QueryFolder } from '../../connection/queryStore.js';
import type { SavedQuery } from '@devbelt/db-core';
import { DatabaseType, databaseTypeFromEngine } from '@devbelt/db-core';
import { decodeEntityPayload, type DecodedEntityPayload } from './recordCodec.js';
import { assertRecordId, assertU64Decimal } from './types.js';
import { filterPersonalConnectionsByEntitlement } from '../entitlementGate.js';
import type { CachedEntitlement } from '../entitlementGate.js';
import { RecordConflictError } from './errors.js';
import type { RecordMapStore, RecordMapEntry } from './recordMapStore.js';
import { EntityStore, UnresolvedRefStore } from './entityStore.js';
import type { SyncEntityType, SyncEntityRef } from './syncEntity.js';
import type { SyncAuthenticatorEntryValue, SyncAuthenticatorGroup, SyncAuthenticatorTag } from './authenticatorTypes.js';

/**
 * 远端 record 的本地应用（A3：四类型 + 拓扑序 + 引用解析 + 环检测 + 级联）。
 *
 * - 版本幂等：仅对 `status='confirmed'` 且 version ≤ recordVersion 不重复写；`pending`
 *   预留视为未完成，重放继续收敛而非跳过。
 * - 新建顺序：先预留 pending 映射（recordId→{type,localId}）并写盘成功，再写实体，回读
 *   `updateTime` 后确认映射；预留失败不写实体。
 * - tombstone：confirmed 且本地未脏 → 删实体（走 store 级联）+ 删映射；本地脏 → 抛冲突；
 *   未映射 → 不建不报错（推进 cursor）。tombstone 无 payload，靠映射反查实体类型。
 * - 引用解析（N2/N4）：parentId/groupId/connId/folderId 的 recordId 经 mapStore 反查本地
 *   id；未到达/类型不符 → 保留 unresolved（不落根），后续轮 reconcile 收敛。
 * - 环检测（N9）：group 应用前校验 parentId 不指向自身、不构成环、嵌套深度 ≤8。
 * - 级联由 store 承担（§三）：连接 tombstone 级联其查询/文件夹；分组 tombstone 仅解除成员
 *   连接分组；文件夹 tombstone 查询移根级。
 * - 写实体走 `source='sync'`；连接解密后先过引擎门禁（墓碑不走门禁）。
 */

export type ApplyDisposition = 'skipped' | 'skipped-entitlement' | 'skipped-unsupported' | 'created' | 'updated' | 'deleted' | 'ignored-tombstone';

export interface ApplyRecordInput {
  recordId: string;
  version: string;
  tombstone: boolean;
  payload?: unknown;
  /** B4 useRemote：跳过本地脏冲突检查，强制采用远端版本。 */
  force?: boolean;
}

export interface ApplyContext {
  entities: EntityStore;
  mapStore: RecordMapStore;
  unresolved: UnresolvedRefStore;
  entitlement?: CachedEntitlement;
  /** 为新本地实体 mint id（按类型）。 */
  uniqueId: (type: SyncEntityType) => string;
}

export interface ApplyRecordResult {
  recordId: string;
  disposition: ApplyDisposition;
}

/**
 * 收敛 unresolved 引用（N2/N4）：对每条 unresolved 引用，若 target recordId 现已映射到
 * 本地实体，则把依赖方实体的引用字段改写为本地 id 并清除该 unresolved 条目；未映射的
 * 保留待后续轮。返回本次收敛条数。
 */
export async function reconcileUnresolved(ctx: ApplyContext): Promise<number> {
  let resolved = 0;
  for (const uref of ctx.unresolved.list()) {
    const entity = ctx.entities.get({ type: uref.type, localId: uref.localId });
    if (!entity) {
      // 依赖方实体已不存在（被删/tombstone 移除），清理悬空引用。
      await ctx.unresolved.remove(uref.targetRecordId);
      continue;
    }
    const target = ctx.mapStore.getByRecordId(uref.targetRecordId);
    if (!target) continue; // 目标未到达，保留待后续轮
    await patchReference(ctx, uref, target.localId);
    await ctx.unresolved.remove(uref.targetRecordId);
    resolved += 1;
  }
  return resolved;
}

async function patchReference(ctx: ApplyContext, uref: { type: SyncEntityType; localId: string; field: 'groupId' | 'parentId' | 'connId' | 'folderId' | 'tags' }, targetLocalId: string): Promise<void> {
  const ref: SyncEntityRef = { type: uref.type, localId: uref.localId };
  const entity = ctx.entities.get(ref);
  if (!entity) return;
  const base = entity as unknown as Record<string, unknown>;
  // tags 是多值引用：把收敛到的本地 tag id 追加进数组（去重）。
  const patched = uref.field === 'tags'
    ? { ...base, tags: Array.from(new Set([...(Array.isArray(base.tags) ? base.tags as string[] : []), targetLocalId])) }
    : { ...base, [uref.field]: targetLocalId };
  await ctx.entities.save(ref, patched as never, 'sync');
}

function resolveLocalId(mapStore: RecordMapStore, type: SyncEntityType, recordId: string | undefined): string | undefined {
  if (!recordId) return undefined;
  const entry = mapStore.getByRecordId(recordId);
  if (!entry || entry.type !== type) return undefined;
  return entry.localId;
}

/** 环/自指/超深检测（N9）：group 应用前父链校验，最多 8 层。 */
export function assertSafeGroupParent(groups: ConnectionGroup[], selfId: string, parentId: string): void {
  if (parentId === selfId) throw new Error('group hierarchy must not contain a cycle');
  let cur = parentId;
  let depth = 0;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) throw new Error('group hierarchy must not contain a cycle');
    seen.add(cur);
    const parent = groups.find((g) => g.id === cur);
    if (!parent || !parent.parentId) break;
    cur = parent.parentId;
    depth += 1;
    if (depth > 8) throw new Error('group hierarchy exceeds maximum depth of 8');
  }
}

function updateTimeOf(entity: unknown): number {
  return (entity as { updateTime?: number })?.updateTime ?? 0;
}

/** 实体是否回报了数值型 updateTime（缺省不得被静默当作 0 接受）。 */
function hasUpdateTime(entity: unknown): boolean {
  return typeof (entity as { updateTime?: unknown })?.updateTime === 'number';
}

/**
 * 连接 payload 是否使用了本客户端不认识的引擎（如未来新增的 ES）。
 *
 * 旧客户端拉到新引擎记录时，`decodeEntityPayload` 会因 `databaseTypeFromEngine` fail-closed
 * 抛错，导致整页应用失败、游标不前进、入站同步永久卡住（H3）。此处提前判定，把未知引擎
 * 当作 `skipped-unsupported` 入 deferred，保证向前兼容（游标前进，未来支持后可重放）。
 */
function connectionEngineUnsupported(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'connection') return false;
  if (typeof p.dbType !== 'string') return false;
  try {
    // P8：ES 已接入引擎枚举但尚未接入同步 codec —— 视作未支持引擎（skipped-unsupported，游标前进）。
    return databaseTypeFromEngine(p.dbType) === DatabaseType.ELASTICSEARCH;
  } catch {
    return true;
  }
}

export async function applyRecord(input: ApplyRecordInput, ctx: ApplyContext): Promise<ApplyRecordResult> {
  assertRecordId(input.recordId);
  const version = assertU64Decimal(input.version, 'version');
  const existing = ctx.mapStore.getByRecordId(input.recordId);

  if (!input.force && existing && existing.status === 'confirmed' && BigInt(version) <= BigInt(existing.recordVersion)) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (input.tombstone) {
    return applyTombstone(input.recordId, version, existing, ctx, input.force === true);
  }

  // 未知引擎：不抛错，跳过并入 deferred（向前兼容；否则旧客户端入站同步会永久卡住）。
  if (connectionEngineUnsupported(input.payload)) {
    return { recordId: input.recordId, disposition: 'skipped-unsupported' };
  }

  const decoded = decodeEntityPayload(input.payload);
  return applyActive(input.recordId, version, decoded, existing, ctx, input.force === true);
}

async function applyTombstone(recordId: string, version: string, existing: (RecordMapEntry & { recordId: string }) | undefined, ctx: ApplyContext, force: boolean): Promise<ApplyRecordResult> {
  if (!existing) {
    return { recordId, disposition: 'ignored-tombstone' };
  }
  const ref: SyncEntityRef = { type: existing.type, localId: existing.localId };
  const local = ctx.entities.get(ref);
  if (existing.status === 'pending' && local) {
    if (!force) throw new RecordConflictError(recordId, existing.recordVersion, version, 'pending');
  }
  if (existing.status === 'confirmed' && local && updateTimeOf(local) > existing.revision) {
    if (!force) throw new RecordConflictError(recordId, existing.recordVersion, version);
  }
  await ctx.entities.remove(ref, 'sync');
  await ctx.mapStore.deleteByRecordId(recordId);
  return { recordId, disposition: 'deleted' };
}

async function applyActive(
  recordId: string,
  version: string,
  decoded: DecodedEntityPayload,
  existing: (RecordMapEntry & { recordId: string }) | undefined,
  ctx: ApplyContext,
  force: boolean,
): Promise<ApplyRecordResult> {
  const type = decoded.type;

  if (type === 'connection') {
    const { skipped } = filterPersonalConnectionsByEntitlement(
      [buildConnectionFromPayload(decoded.data)],
      ctx.entitlement,
    );
    if (skipped.length > 0) {
      // 与「版本重放的 skipped」区分：这类必须入 deferred 等权益放开后重放，
      // 无论该记录是否已有本地映射（降级时已映射的记录同样会漏更新）。
      return { recordId, disposition: 'skipped-entitlement' };
    }
  }

  if (existing) {
    const local = ctx.entities.get({ type, localId: existing.localId });
    if (existing.status === 'pending' && local && !force) {
      throw new RecordConflictError(recordId, existing.recordVersion, version, 'pending');
    }
    if (existing.status === 'confirmed' && local && updateTimeOf(local) > existing.revision && !force) {
      throw new RecordConflictError(recordId, existing.recordVersion, version);
    }
    const targetRef: SyncEntityRef = { type, localId: local ? existing.localId : ctx.uniqueId(type) };
    await writeEntity(targetRef, decoded, ctx);
    const saved = ctx.entities.get(targetRef);
    if (!saved || !hasUpdateTime(saved)) {
      throw new Error('entity save did not report updateTime');
    }
    try {
      await ctx.mapStore.put(recordId, { type, localId: targetRef.localId, recordVersion: version, revision: updateTimeOf(saved), status: 'confirmed' });
    } catch (error) {
      if (local) await restoreEntity({ type, localId: existing.localId }, local, ctx);
      else await ctx.entities.remove(targetRef, 'sync');
      throw error;
    }
    return { recordId, disposition: local ? 'updated' : 'created' };
  }

  // 新建：先预留 pending 映射，再写实体，最后确认版本。
  const newId = ctx.uniqueId(type);
  await ctx.mapStore.put(recordId, { type, localId: newId, recordVersion: version, revision: 0, status: 'pending' });
  try {
    await writeEntity({ type, localId: newId }, decoded, ctx);
  } catch (error) {
    let rollbackFailed = false;
    try {
      await ctx.mapStore.deleteByRecordId(recordId);
    } catch {
      rollbackFailed = true;
    }
    const causeError = new Error(rollbackFailed
      ? 'apply failed and reservation rollback failed; pending mapping kept for recovery'
      : 'entity save failed and reservation rollback succeeded') as Error & { cause?: unknown };
    causeError.cause = error;
    throw causeError;
  }
  const saved = ctx.entities.get({ type, localId: newId });
  if (!saved || !hasUpdateTime(saved)) {
    await ctx.mapStore.deleteByRecordId(recordId).catch(() => {});
    throw new Error('entity save did not report updateTime');
  }
  await ctx.mapStore.put(recordId, { type, localId: newId, recordVersion: version, revision: updateTimeOf(saved), status: 'confirmed' });
  return { recordId, disposition: 'created' };
}

async function restoreEntity(ref: SyncEntityRef, original: unknown, ctx: ApplyContext): Promise<void> {
  switch (ref.type) {
    case 'connection': return ctx.entities.save(ref, original as SavedConnection, 'sync');
    case 'group': return ctx.entities.save(ref, original as ConnectionGroup, 'sync');
    case 'queryFolder': return ctx.entities.save(ref, original as QueryFolder, 'sync');
    case 'query': return ctx.entities.save(ref, original as SavedQuery, 'sync');
    case 'authenticatorGroup': return ctx.entities.save(ref, original as SyncAuthenticatorGroup, 'sync');
    case 'authenticatorTag': return ctx.entities.save(ref, original as SyncAuthenticatorTag, 'sync');
    case 'authenticatorEntry': return ctx.entities.save(ref, original as SyncAuthenticatorEntryValue, 'sync');
  }
}

async function writeEntity(ref: SyncEntityRef, decoded: DecodedEntityPayload, ctx: ApplyContext): Promise<void> {
  // 分组环检测：应用前校验 parentId 解析结果（N9）。
  let parentLocalId: string | undefined;
  switch (decoded.type) {
    case 'connection': {
      const groupLocalId = resolveLocalId(ctx.mapStore, 'group', decoded.data.groupId);
      if (decoded.data.groupId && groupLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.groupId, type: ref.type, localId: ref.localId, field: 'groupId' });
      }
      await ctx.entities.save(ref, buildConnectionFromPayload(decoded.data, ref.localId, groupLocalId), 'sync');
      return;
    }
    case 'group': {
      parentLocalId = resolveLocalId(ctx.mapStore, 'group', decoded.data.parentId);
      if (decoded.data.parentId && parentLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.parentId, type: ref.type, localId: ref.localId, field: 'parentId' });
      } else if (parentLocalId) {
        assertSafeGroupParent(collectionOfGroups(ctx.entities), ref.localId, parentLocalId);
      }
      await ctx.entities.save(ref, buildGroupFromPayload(decoded.data, ref.localId, parentLocalId), 'sync');
      return;
    }
    case 'queryFolder': {
      const connLocalId = resolveLocalId(ctx.mapStore, 'connection', decoded.data.connId);
      if (decoded.data.connId && connLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.connId, type: ref.type, localId: ref.localId, field: 'connId' });
      }
      await ctx.entities.save(ref, buildFolderFromPayload(decoded.data, ref.localId, connLocalId), 'sync');
      return;
    }
    case 'query': {
      const connLocalId = resolveLocalId(ctx.mapStore, 'connection', decoded.data.connId);
      if (decoded.data.connId && connLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.connId, type: ref.type, localId: ref.localId, field: 'connId' });
      }
      const folderLocalId = resolveLocalId(ctx.mapStore, 'queryFolder', decoded.data.folderId);
      if (decoded.data.folderId && folderLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.folderId, type: ref.type, localId: ref.localId, field: 'folderId' });
      }
      await ctx.entities.save(ref, buildQueryFromPayload(decoded.data, ref.localId, connLocalId, folderLocalId), 'sync');
      return;
    }
    case 'authenticatorGroup': {
      await ctx.entities.save(ref, buildAuthenticatorGroupFromPayload(decoded.data, ref.localId), 'sync');
      return;
    }
    case 'authenticatorTag': {
      await ctx.entities.save(ref, buildAuthenticatorTagFromPayload(decoded.data, ref.localId), 'sync');
      return;
    }
    case 'authenticatorEntry': {
      const groupLocalId = resolveLocalId(ctx.mapStore, 'authenticatorGroup', decoded.data.groupId);
      if (decoded.data.groupId && groupLocalId === undefined) {
        await ctx.unresolved.add({ targetRecordId: decoded.data.groupId, type: ref.type, localId: ref.localId, field: 'groupId' });
      }
      const tagLocalIds: string[] = [];
      for (const tagRecordId of decoded.data.tags ?? []) {
        const tagLocalId = resolveLocalId(ctx.mapStore, 'authenticatorTag', tagRecordId);
        if (tagLocalId === undefined) {
          await ctx.unresolved.add({ targetRecordId: tagRecordId, type: ref.type, localId: ref.localId, field: 'tags' });
        } else {
          tagLocalIds.push(tagLocalId);
        }
      }
      await ctx.entities.save(ref, buildAuthenticatorEntryFromPayload(decoded.data, ref.localId, groupLocalId, tagLocalIds), 'sync');
      return;
    }
  }
}

function collectionOfGroups(entities: EntityStore): ConnectionGroup[] {
  const out: ConnectionGroup[] = [];
  for (const rec of entities.listForSync()) {
    if (rec.ref.type === 'group') {
      const g = entities.get(rec.ref) as ConnectionGroup | undefined;
      if (g) out.push(g);
    }
  }
  return out;
}

function buildConnectionFromPayload(p: Extract<DecodedEntityPayload, { type: 'connection' }>['data'], id?: string, groupId?: string): SavedConnection {
  const { groupId: _groupId, ...rest } = p as unknown as Record<string, unknown>;
  const base = p.dbType === DatabaseType.SQLITE
    ? { id: id ?? '', host: '', port: 0, user: '', useConnectionString: false }
    : { id: id ?? '', useConnectionString: false };
  return { ...base, ...rest, groupId } as unknown as SavedConnection;
}

function buildGroupFromPayload(p: Extract<DecodedEntityPayload, { type: 'group' }>['data'], id: string, parentId: string | undefined): ConnectionGroup {
  return { id, name: p.name, parentId } as ConnectionGroup;
}

function buildFolderFromPayload(p: Extract<DecodedEntityPayload, { type: 'queryFolder' }>['data'], id: string, connId: string | undefined): QueryFolder {
  return { id, name: p.name, connId: connId ?? '' } as QueryFolder;
}

function buildQueryFromPayload(p: Extract<DecodedEntityPayload, { type: 'query' }>['data'], id: string, connId: string | undefined, folderId: string | undefined): SavedQuery {
  return {
    id,
    name: p.name,
    sql: p.sql,
    connId: connId ?? '',
    database: p.database,
    folderId,
  } as SavedQuery;
}

function buildAuthenticatorGroupFromPayload(p: Extract<DecodedEntityPayload, { type: 'authenticatorGroup' }>['data'], id: string): SyncAuthenticatorGroup {
  return { id, name: p.name, sortOrder: p.sortOrder };
}

function buildAuthenticatorTagFromPayload(p: Extract<DecodedEntityPayload, { type: 'authenticatorTag' }>['data'], id: string): SyncAuthenticatorTag {
  return { id, name: p.name, color: p.color };
}

function buildAuthenticatorEntryFromPayload(
  p: Extract<DecodedEntityPayload, { type: 'authenticatorEntry' }>['data'],
  id: string,
  groupId: string | undefined,
  tags: string[],
): SyncAuthenticatorEntryValue {
  return {
    id,
    issuer: p.issuer,
    account: p.account,
    algorithm: p.algorithm,
    digits: p.digits,
    period: p.period,
    groupId,
    tags,
    createTime: p.createTime,
    updateTime: p.updateTime,
    secret: p.secret,
  };
}