import { applyOrder, type EntityStore } from './entityStore.js';
import type { RecordMapStore } from './recordMapStore.js';
import type { PendingMutation } from './pendingMutationStore.js';
import type { RemoteRecord } from './syncEngine.js';
import { refKey, type SyncEntityType } from './syncEntity.js';

/**
 * 对账域（S7k.11 重构）：「发现什么」与「怎么修」的唯一事实源。
 *
 * 此前这些规则散落在 syncEngine 的多个分支里（S7k→S7k.10 十轮修补的产物）；
 * 现在收敛为**一张状态矩阵**：每条不一致 = 本机态 × 云端态 → 发现类别，
 * 每个发现类别 × 修复方向 → 执行原语（含退化规则，单一位置定义）。
 * 引擎（syncEngine）只保留机制层：扫描、applyRecord、签名推送、定向推送。
 *
 * | 本机 \ 云端 | 存活 | 墓碑 | 查无 |
 * |---|---|---|---|
 * | 存活（有映射） | 字段差异（nameDrift/refDrift） | remoteDeleted | （映射级残留，见 missing 兜底） |
 * | 存活（无映射空组） | orphanGroup（本机残留） | — | orphanGroup |
 * | 较新墓碑（无待推出站） | orphanDelete | remoteDeleted（收敛删除） | 映射级残留 |
 * | 陈旧墓碑 | missing（复活） | remoteDeleted | 映射级残留 |
 * | 缺失 | missing | remoteDeleted | — |
 * | 有待推出站 | 不产生发现（尊重出站意图） | 不产生发现 | 不产生发现 |
 */

export type FindingKind = 'missing' | 'nameDrift' | 'refDrift' | 'orphanDelete' | 'remoteDeleted' | 'orphanGroup';
export type RepairDirection = 'cloud' | 'local' | 'merge';

/** 体检发现的单项不一致（只读检测，零写入；面板逐条展示、用户选择修复）。 */
export interface SyncFinding {
  /** 稳定选择键（面板勾选/逐条修复回传；`${kind}:${type}:${localId}`）。 */
  id: string;
  kind: FindingKind;
  type: SyncEntityType;
  /** 云端 recordId（orphanGroup 无云端记录）。 */
  recordId?: string;
  localId: string;
  /** 展示值：本机侧（名字或引用目标显示名；缺失类为空）。 */
  localValue?: string;
  /** 展示值：云端侧。 */
  remoteValue?: string;
  /** 引用漂移明细（字段名 + 两侧展示值；视图翻译字段名；目标缺失时 remoteMissing）。 */
  ref?: { field: string; local?: string; remote?: string; remoteMissing?: boolean };
}

/** 检测结果：发现列表 + 扫描完整性。 */
export interface FindingsReport {
  findings: SyncFinding[];
  /** 扫描提前中断（分页截断等）：发现可能未穷尽，面板应提示重试。 */
  incomplete: boolean;
}

/** 修复原语（由引擎机制层执行；每条发现按矩阵解析出 0..1 个原语）。 */
export type ReconcileOpName =
  | 'applyCloudPut'      // 按云端覆盖本机（存活记录 force 重放）
  | 'applyCloudTombstone' // 按云端收敛删除（应用墓碑）
  | 'pushPut'            // 用本机内容覆盖云端（定向推送）
  | 'pushDelete'         // 把本机删除意图推上云端（定向推送）
  | 'mergeThenPush'      // 字段级合并落地本机，再推送合并结果
  | 'sweepLocal'         // 清理本机孤儿残留（无映射空分组）
  | 'skip';              // 该方向对该类别无意义（面板不提供该按钮）

/**
 * 状态矩阵：发现类别 × 方向 → 原语。
 * 未列出的格子回退 `cloud` 列（单一退化规则）；`skip` 表示显式无操作。
 * UI 的按钮可见性（hasLocalDirection/hasMerge）与本表一致：local/merge 列为 skip 或缺失的类别不提供该按钮。
 */
const OP_TABLE: Record<FindingKind, { cloud?: ReconcileOpName; local?: ReconcileOpName; merge?: ReconcileOpName }> = {
  // 云端有、本机没有：使用云端=恢复到本机；使用本机=删除云端这条（本机侧为空）。
  missing: { cloud: 'applyCloudPut', local: 'pushDelete', merge: 'skip' },
  // 两侧都存活、内容不同：三向全开放。
  nameDrift: { cloud: 'applyCloudPut', local: 'pushPut', merge: 'mergeThenPush' },
  refDrift: { cloud: 'applyCloudPut', local: 'pushPut', merge: 'mergeThenPush' },
  // 本机已删、云端仍在：恢复 or 保持删除并推送。
  orphanDelete: { cloud: 'applyCloudPut', local: 'pushDelete' },
  // 云端已删、本机仍在：收敛删除 or 用本机复活云端。
  remoteDeleted: { cloud: 'applyCloudTombstone', local: 'pushPut' },
  // 本机残留的孤儿空分组（云端没有）：清理本机（方向无关）。
  orphanGroup: { cloud: 'sweepLocal', local: 'skip', merge: 'skip' },
};

/** 解析（矩阵查表）：发现 × 方向 → 原语名。未提供方向回退 cloud（单一退化规则）。 */
export function resolveOpName(kind: FindingKind, direction: RepairDirection): ReconcileOpName {
  const row = OP_TABLE[kind];
  return row[direction] ?? row.cloud ?? 'skip';
}

/** 对账单条动作（分类产物；引擎据此扫描云端）。 */
export interface ReconcileAction {
  recordId: string;
  type: SyncEntityType;
  localId: string;
  kind: 'missing' | 'revive' | 'relink' | 'orphanDelete';
}

export interface EntitySummary {
  ref: { type: SyncEntityType; localId: string };
  deleted: boolean;
  updateTime: number;
}

/**
 * 分类（唯一动作表）：每条 confirmed 映射归入且仅归入一个动作。
 * - 有待推出站 → 不产生动作（尊重出站意图，等推送收敛）；
 * - 实体缺失 / 陈旧墓碑（updateTime ≤ revision）→ missing / revive；
 * - 较新墓碑且无待推出站 → orphanDelete（孤儿墓碑：删除永不会被推送的损坏态）；
 * - 存活且带引用/命名 → relink（检测时比对字段）。
 */
export function classifyActions(
  mappings: Array<{ type: SyncEntityType; localId: string; recordId: string; status: string; revision: number }>,
  outbox: PendingMutation[],
  summaries: EntitySummary[],
): { actions: ReconcileAction[]; orphanTombstones: number } {
  const pendingRefs = new Set(outbox.map((m) => refKey({ type: m.type, localId: m.localId })));
  const localSummaries = new Map(summaries.map((r) => [refKey(r.ref), r]));
  const actions: ReconcileAction[] = [];
  let orphanTombstones = 0;
  for (const entry of mappings) {
    if (entry.status !== 'confirmed') continue;
    const key = refKey({ type: entry.type, localId: entry.localId });
    const summary = localSummaries.get(key);
    if (pendingRefs.has(key)) continue; // 有出站：尊重意图，不产生发现
    if (!summary) {
      actions.push({ recordId: entry.recordId, type: entry.type, localId: entry.localId, kind: 'missing' });
      continue;
    }
    if (!summary.deleted) {
      if (RELINK_TYPES.has(entry.type)) {
        actions.push({ recordId: entry.recordId, type: entry.type, localId: entry.localId, kind: 'relink' });
      }
      continue;
    }
    if (summary.updateTime > entry.revision) {
      orphanTombstones += 1;
      actions.push({ recordId: entry.recordId, type: entry.type, localId: entry.localId, kind: 'orphanDelete' });
    } else {
      actions.push({ recordId: entry.recordId, type: entry.type, localId: entry.localId, kind: 'revive' });
    }
  }
  return { actions, orphanTombstones };
}

/** 字段比对目标类型（带交叉引用或命名的实体）。 */
const RELINK_TYPES: ReadonlySet<SyncEntityType> = new Set<SyncEntityType>([
  'connection', 'group', 'queryFolder', 'query',
  'authenticatorEntry', 'authenticatorGroup', 'authenticatorTag',
  'schemaNotes', 'aiModelAccess',
]);

/** 展示值：实体名（条目用 issuer( account)，其余类型用 name）。 */
export function displayValue(type: SyncEntityType, entity: unknown): string | undefined {
  if (!entity || typeof entity !== 'object') return undefined;
  const e = entity as Record<string, unknown>;
  if (type === 'authenticatorEntry') {
    const issuer = typeof e.issuer === 'string' ? e.issuer : '';
    const account = typeof e.account === 'string' && e.account ? ` (${e.account})` : '';
    return `${issuer}${account}` || undefined;
  }
  return typeof e.name === 'string' && e.name ? e.name : undefined;
}

/** 检测上下文（引擎注入：实体与映射读取面）。 */
export interface ReconcileCtx {
  entities: EntityStore;
  mapStore: RecordMapStore;
}

/**
 * 各类型的引用字段（字段名 → 目标类型；tags 为数组字段）。
 * 对称比较的依据：**recordId**（云端 payload 值 vs 本机引用经映射解析的 recordId）。
 */
const REF_FIELDS: Partial<Record<SyncEntityType, Array<{ field: string; targetType: SyncEntityType }>>> = {
  connection: [{ field: 'groupId', targetType: 'group' }],
  group: [{ field: 'parentId', targetType: 'group' }],
  queryFolder: [{ field: 'connId', targetType: 'connection' }],
  query: [{ field: 'connId', targetType: 'connection' }, { field: 'folderId', targetType: 'queryFolder' }],
  schemaNotes: [{ field: 'connId', targetType: 'connection' }],
  authenticatorEntry: [{ field: 'groupId', targetType: 'authenticatorGroup' }, { field: 'tags', targetType: 'authenticatorTag' }],
};

/**
 * 单条 relink 干跑比对（**对称**）：命名差异 + 引用差异（本机侧与云端侧都参与——
 * 本机有引用而云端没有也算漂移）。展示值经映射+实体名解析；目标本机缺失 → remoteMissing
 * （视图白话「（本机缺失）」，该目标自身的「云端有本机没有」发现由全量对账兜底产出）。
 * 无差异返回 undefined。
 */
function diffRecord(
  action: ReconcileAction,
  payload: Record<string, unknown>,
  ctx: ReconcileCtx,
): {
  name?: { local?: string; remote: string };
  refs?: Array<{ field: string; local?: string; remote?: string; remoteMissing?: boolean }>;
} | undefined {
  const local = ctx.entities.get({ type: action.type, localId: action.localId }) as Record<string, unknown> | undefined;
  const diff: {
    name?: { local?: string; remote: string };
    refs?: Array<{ field: string; local?: string; remote?: string; remoteMissing?: boolean }>;
  } = {};

  // 命名漂移：云端载荷带 name 的实体一律比对（条目载荷无 name，自动不适用）。
  if (typeof payload.name === 'string') {
    const localName = typeof local?.name === 'string' ? local.name : undefined;
    if (payload.name !== localName) diff.name = { local: localName, remote: payload.name };
  }

  const refDiffs: Array<{ field: string; local?: string; remote?: string; remoteMissing?: boolean }> = [];
  for (const { field, targetType } of REF_FIELDS[action.type] ?? []) {
    const cloudValue = payload[field];
    const localValue = local?.[field];
    const targetDisplay = (localId: string | undefined): { display?: string; missing?: boolean } => {
      if (!localId) return {};
      const entity = ctx.entities.get({ type: targetType, localId });
      // 缺失：不回退显示内部 id（视图以「（本机缺失）」表达；其云端名由全量对账发现携带）。
      if (!entity) return { missing: true };
      return { display: displayValue(targetType, entity) ?? localId };
    };
    if (field === 'tags') {
      // 标签集合比较（recordId 集合）：云端 tags vs 本机 tags（经映射解析）。
      const cloudIds = Array.isArray(cloudValue) ? (cloudValue as string[]).map(String) : [];
      const localIds = Array.isArray(localValue) ? (localValue as string[]).map(String) : [];
      const cloudResolved = cloudIds.map((rid) => ctx.mapStore.getByRecordId(rid)?.localId);
      const cloudSet = new Set(cloudIds);
      const localSet = new Set(localIds.map((lid) => ctx.mapStore.getByRef({ type: targetType, localId: lid })?.recordId).filter(Boolean) as string[]);
      const same = cloudIds.every((rid) => localSet.has(rid)) && [...localSet].every((rid) => cloudSet.has(rid));
      if (!same && (cloudIds.length > 0 || localIds.length > 0)) {
        const c = cloudResolved.map((lid) => targetDisplay(lid));
        const l = localIds.map((lid) => targetDisplay(lid));
        refDiffs.push({
          field: 'tags',
          local: l.length ? l.map((x) => x.display).filter(Boolean).join('、') : undefined,
          remote: c.length ? c.map((x) => x.display).filter(Boolean).join('、') : undefined,
          remoteMissing: c.some((x) => x.missing) || undefined,
        });
      }
    } else {
      // 单值引用比较（recordId 基准）：云端值 vs 本机值解析后的 recordId。
      const cloudRecordId = typeof cloudValue === 'string' ? cloudValue : undefined;
      const localRecordId = typeof localValue === 'string'
        ? ctx.mapStore.getByRef({ type: targetType, localId: localValue })?.recordId
        : undefined;
      if (cloudRecordId !== localRecordId && (cloudRecordId !== undefined || localRecordId !== undefined)) {
        const cloudLocalId = cloudRecordId !== undefined ? ctx.mapStore.getByRecordId(cloudRecordId)?.localId : undefined;
        const c = targetDisplay(cloudLocalId);
        const l = targetDisplay(typeof localValue === 'string' ? localValue : undefined);
        refDiffs.push({
          field,
          local: l.display,
          remote: c.display,
          remoteMissing: c.missing || undefined,
        });
      }
    }
  }
  if (refDiffs.length) diff.refs = refDiffs;
  return diff.name || diff.refs ? diff : undefined;
}

/**
 * 由动作 × 云端扫描结果构建发现列表（状态矩阵的检测侧；映射 confirmed 的记录）：
 * - 云端墓碑 → remoteDeleted（无论本机态：收敛删除）；
 * - 云端存活 + 本机缺失/陈旧墓碑 → missing；
 * - 云端存活 + 本机较新墓碑（orphanDelete）→ orphanDelete；
 * - 云端存活 + 本机存活 → 字段差异（nameDrift/refDrift，对称比较）。
 */
export function findingsFromScan(
  actions: ReconcileAction[],
  latestByRecord: Map<string, RemoteRecord>,
  openPayload: (rec: RemoteRecord) => Record<string, unknown> | undefined,
  ctx: ReconcileCtx,
): { findings: SyncFinding[] } {
  const findings: SyncFinding[] = [];
  for (const action of actions) {
    const rec = latestByRecord.get(action.recordId);
    if (!rec) continue; // 云端查无（feed 截断/漂移）：无法判定，不产生发现
    const localEntity = ctx.entities.get({ type: action.type, localId: action.localId });
    const push = (f: SyncFinding): void => { findings.push(f); };

    if (rec.deleteTime != null) {
      push({
        id: `remoteDeleted:${action.type}:${action.localId}`,
        kind: 'remoteDeleted',
        type: action.type,
        recordId: action.recordId,
        localId: action.localId,
        localValue: displayValue(action.type, localEntity),
      });
      continue;
    }
    if (action.kind === 'missing' || action.kind === 'revive') {
      push({
        id: `missing:${action.type}:${action.localId}`,
        kind: 'missing',
        type: action.type,
        recordId: action.recordId,
        localId: action.localId,
        remoteValue: displayValue(action.type, openPayload(rec)),
      });
      continue;
    }
    if (action.kind === 'orphanDelete') {
      push({
        id: `orphanDelete:${action.type}:${action.localId}`,
        kind: 'orphanDelete',
        type: action.type,
        recordId: action.recordId,
        localId: action.localId,
        localValue: displayValue(action.type, localEntity),
        remoteValue: displayValue(action.type, openPayload(rec)),
      });
      continue;
    }
    // relink：字段差异（无差异不产生发现）。
    const payload = openPayload(rec);
    if (!payload) continue;
    const diff = diffRecord(action, payload, ctx);
    if (diff?.name) {
      push({
        id: `nameDrift:${action.type}:${action.localId}`,
        kind: 'nameDrift',
        type: action.type,
        recordId: action.recordId,
        localId: action.localId,
        localValue: diff.name.local,
        remoteValue: diff.name.remote,
      });
    }
    if (diff?.refs?.length) {
      const first = diff.refs[0];
      push({
        id: `refDrift:${action.type}:${action.localId}`,
        kind: 'refDrift',
        type: action.type,
        recordId: action.recordId,
        localId: action.localId,
        localValue: displayValue(action.type, localEntity),
        ref: { field: first.field, local: first.local, remote: first.remote, remoteMissing: first.remoteMissing || undefined },
      });
    }
  }
  return { findings };
}

/**
 * 全量对账兜底（S7k.12）：云端**存活**但本机没有本地呈现的记录 → 「云端有，本机没有」：
 * - 无映射 → 恢复时 mint 新实体（id 以 recordId 寻址）；
 * - pending 映射且实体缺失且无待推出站（孤儿 pending）→ 恢复并 force 确认；
 * - pending 映射且实体在/有出站 → 在途，跳过；confirmed 映射 → 动作驱动路径已覆盖。
 * 此前这类记录完全不可见（面板谎报「一致」的根源：检测只看映射过的记录）。
 */
export function cloudOnlyFindings(
  records: Map<string, RemoteRecord>,
  mappings: Array<{ recordId: string; type: SyncEntityType; localId: string; status: string }>,
  outbox: PendingMutation[],
  entities: EntityStore,
  openPayload: (rec: RemoteRecord) => Record<string, unknown> | undefined,
  existing: SyncFinding[],
): SyncFinding[] {
  const byRecord = new Map(mappings.map((m) => [m.recordId, m]));
  const outboxRefs = new Set(outbox.map((m) => refKey({ type: m.type, localId: m.localId })));
  const out: SyncFinding[] = [];
  for (const [recordId, rec] of records) {
    if (rec.deleteTime != null) continue;
    const mapping = byRecord.get(recordId);
    if (!mapping) {
      const payload = openPayload(rec);
      const type = typeof payload?.type === 'string' ? (payload.type as SyncEntityType) : undefined;
      if (!type) continue;
      out.push({ id: `missing:${type}:${recordId}`, kind: 'missing', type, recordId, localId: '', remoteValue: displayValue(type, payload) });
      continue;
    }
    if (mapping.status === 'confirmed') continue;
    if (outboxRefs.has(refKey({ type: mapping.type, localId: mapping.localId }))) continue;
    if (entities.get({ type: mapping.type, localId: mapping.localId }) !== undefined) continue;
    out.push({ id: `missing:${mapping.type}:${mapping.localId}`, kind: 'missing', type: mapping.type, recordId, localId: mapping.localId, remoteValue: displayValue(mapping.type, openPayload(rec)) });
  }
  return out.filter((f) => !existing.some((x) => x.id === f.id));
}

/**
 * 孤儿验证器空分组候选（纯本地判定）：无映射（=永不同步）+ 无待推出站 + 无存活条目引用 +
 * 非新建（60s 防御，可能只是尚未同步的新组）。
 */
export function orphanGroupCandidates(
  summaries: EntitySummary[],
  mappings: Array<{ type: SyncEntityType; localId: string }>,
  outbox: PendingMutation[],
  entities: EntityStore,
  now = Date.now(),
): string[] {
  const mapped = new Set(mappings.map((e) => refKey({ type: e.type, localId: e.localId })));
  const outboxRefs = new Set(outbox.map((m) => refKey({ type: m.type, localId: m.localId })));
  const referencedGroups = new Set<string>();
  for (const e of summaries) {
    if (e.ref.type !== 'authenticatorEntry' || e.deleted) continue;
    const entry = entities.get(e.ref) as { groupId?: string } | undefined;
    if (entry?.groupId) referencedGroups.add(entry.groupId);
  }
  const out: string[] = [];
  for (const g of summaries) {
    if (g.ref.type !== 'authenticatorGroup' || g.deleted) continue;
    const key = refKey(g.ref);
    if (mapped.has(key) || outboxRefs.has(key)) continue;
    if (referencedGroups.has(g.ref.localId)) continue;
    if (now - g.updateTime < 60_000) continue;
    out.push(g.ref.localId);
  }
  return out;
}

/** 修复排序：分组/连接先落（引用目标先于依赖方）。 */
export function findingOrder(a: SyncFinding, b: SyncFinding): number {
  return applyOrder(a.type) - applyOrder(b.type);
}
