import type { ConnectionStore, SavedConnection } from '../../connection/connectionStore';
import { databaseTypeFromEngine } from './recordCodec';
import { assertRecordId, assertU64Decimal } from './types';
import { filterPersonalConnectionsByEntitlement } from '../entitlementGate';
import type { CachedEntitlement } from '../authService';
import { V3RecordConflictError } from './errors';
import type { RecordMapStore } from './recordMapStore';

/**
 * 远端 record 的本地应用（B3b，ADR-0007 #3 + 冻结裁定）。
 *
 * - 版本幂等：version ≤ 已确认 recordVersion 不重复写。
 * - tombstone：已映射 → 删连接 + 删映射；未映射 → 不建不报错（推进 cursor）。
 * - 本地脏 + 更高 version → 抛 V3RecordConflictError（不含秘密），调用方保留连接与 cursor。
 * - 写连接走 `source='v3-sync'`（并存期隔离，不触发 V2 autoSync）。
 * - 解密成功后先过引擎门禁（墓碑不走门禁）。
 */

export type ApplyDisposition = 'skipped' | 'created' | 'updated' | 'deleted' | 'ignored-tombstone';

export interface ApplyRecordInput {
  recordId: string;
  version: string;
  tombstone: boolean;
  payload?: Record<string, unknown>;
}

export interface ApplyContext {
  store: ConnectionStore;
  mapStore: RecordMapStore;
  entitlement?: CachedEntitlement;
  /** 生成新的非碰撞本地 connectionId（uniqueId('c') + 碰撞重生成） */
  uniqueConnectionId: () => string;
}

export interface ApplyRecordResult {
  recordId: string;
  disposition: ApplyDisposition;
}

export function applyRecord(input: ApplyRecordInput, ctx: ApplyContext): ApplyRecordResult {
  assertRecordId(input.recordId);
  const version = assertU64Decimal(input.version, 'version');
  const existing = ctx.mapStore.getByRecordId(input.recordId);

  if (existing && BigInt(version) <= BigInt(existing.recordVersion)) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (input.tombstone) {
    if (existing) {
      ctx.store.remove(existing.connectionId, 'v3-sync');
      ctx.mapStore.deleteByRecordId(input.recordId);
      return { recordId: input.recordId, disposition: 'deleted' };
    }
    return { recordId: input.recordId, disposition: 'ignored-tombstone' };
  }

  const conn = payloadToConnection(input.payload ?? {});
  const { skipped } = filterPersonalConnectionsByEntitlement([conn], ctx.entitlement);
  if (skipped.length > 0) {
    return { recordId: input.recordId, disposition: 'skipped' };
  }

  if (existing) {
    const local = ctx.store.get(existing.connectionId);
    if (local && (local.updateTime ?? 0) > existing.revision) {
      throw new V3RecordConflictError(input.recordId, existing.recordVersion, version);
    }
    const connectionId = local ? existing.connectionId : ctx.uniqueConnectionId();
    ctx.store.save({ ...conn, id: connectionId }, 'v3-sync');
    const saved = ctx.store.get(connectionId);
    ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: saved?.updateTime ?? 0 });
    return { recordId: input.recordId, disposition: local ? 'updated' : 'created' };
  }

  const connectionId = ctx.uniqueConnectionId();
  ctx.store.save({ ...conn, id: connectionId }, 'v3-sync');
  const saved = ctx.store.get(connectionId);
  ctx.mapStore.put(input.recordId, { connectionId, recordVersion: version, revision: saved?.updateTime ?? 0 });
  return { recordId: input.recordId, disposition: 'created' };
}

function payloadToConnection(p: Record<string, unknown>): SavedConnection {
  const dbType = databaseTypeFromEngine(String(p.dbType));
  const str = (k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
  const bool = (k: string): boolean | undefined => (typeof p[k] === 'boolean' ? (p[k] as boolean) : undefined);
  return {
    id: '',
    name: str('name') ?? '',
    dbType,
    host: str('host') ?? '',
    port: num('port') ?? 0,
    user: str('user') ?? '',
    password: str('password'),
    database: str('database'),
    schema: str('schema'),
    timezone: str('timezone'),
    groupId: str('groupId'),
    environment: (str('environment') as SavedConnection['environment']) ?? 'development',
    readOnly: bool('readOnly'),
    useConnectionString: false,
    useSSL: bool('useSSL') ?? false,
    sshHost: str('sshHost'),
    sshPort: num('sshPort'),
    sshUser: str('sshUser'),
    sshPassword: str('sshPassword'),
    sshPassphrase: str('sshPassphrase'),
  };
}