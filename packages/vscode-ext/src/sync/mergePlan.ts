import type { SavedConnection } from '../connection/connectionStore';
import type { QueryFolder } from '../connection/queryStore';
import type { SavedQuery } from '@db-client/core';
import type { QueryHistoryEntry } from '../history/historyStore';
import type { SyncPayload } from './syncPayload';

/** 单条记录的合并变化类型 */
export type MergeChangeKind = 'added' | 'updated' | 'deleted';

/** 单条变化项 */
export interface MergeItemChange {
  id: string;
  kind: MergeChangeKind;
  label: string;
  detail?: string;
}

/** 一个分类的合并差异汇总 */
export interface MergeSection {
  /** 远端将新增（远端独有，非墓碑） */
  added: number;
  /** 远端较新将更新本地 */
  updated: number;
  /** 任一侧墓碑 → 本地将标记删除 */
  deleted: number;
  /** 本地独有（远端无）→ 合并后保留本地，提示需推送 */
  localOnly: number;
  /** 变化项明细（仅 added/updated/deleted） */
  items: MergeItemChange[];
}

/** 历史为日志型，仅统计新增与合并计数 */
export interface HistoryMergeSection {
  added: number;
  merged: number;
}

/** 完整合并计划 */
export interface MergePlan {
  /** 本地有未推送变更（哈希脏 或 任一分段 localOnly>0） */
  hasLocalUnpushed: boolean;
  connections: MergeSection;
  queries: MergeSection;
  folders: MergeSection;
  history: HistoryMergeSection;
}

interface RecordLike {
  id: string;
  deleted?: boolean;
  updateTime?: number;
}

/** 计算单个分类（连接/查询/文件夹）的合并差异，不修改输入。 */
function diffSection<T extends RecordLike>(
  local: T[],
  remote: T[],
  labelOf: (t: T) => string,
  detailOf?: (t: T) => string | undefined,
): MergeSection {
  const localMap = new Map(local.map((x) => [x.id, x]));
  const remoteMap = new Map(remote.map((x) => [x.id, x]));
  const items: MergeItemChange[] = [];
  let added = 0;
  let updated = 0;
  let deleted = 0;

  for (const [id, r] of remoteMap) {
    const l = localMap.get(id);
    if (!l) {
      // 远端独有：远端墓碑对「本地不存在」的项无意义，跳过
      if (r.deleted) continue;
      added++;
      items.push({ id, kind: 'added', label: labelOf(r), detail: detailOf?.(r) });
      continue;
    }
    // 双侧均有
    if (r.deleted || l.deleted) {
      deleted++;
      items.push({ id, kind: 'deleted', label: labelOf(l), detail: detailOf?.(l) });
      continue;
    }
    const rt = r.updateTime ?? 0;
    const lt = l.updateTime ?? 0;
    if (rt > lt) {
      updated++;
      items.push({ id, kind: 'updated', label: labelOf(r), detail: detailOf?.(r) });
    }
  }

  let localOnly = 0;
  for (const [id] of localMap) {
    if (!remoteMap.has(id)) localOnly++;
  }

  return { added, updated, deleted, localOnly, items };
}

function diffHistory(local: QueryHistoryEntry[], remote: QueryHistoryEntry[]): HistoryMergeSection {
  const localIds = new Set(local.map((h) => h.id));
  let added = 0;
  let merged = 0;
  for (const h of remote) {
    if (localIds.has(h.id)) merged++;
    else added++;
  }
  return { added, merged };
}

const connLabel = (c: SavedConnection) => c.name || c.host || c.id;
const connDetail = (c: SavedConnection) => `${c.dbType} ${c.host || ''}${c.port ? `:${c.port}` : ''}`;
const queryLabel = (q: SavedQuery) => q.name || q.id;
const folderLabel = (f: QueryFolder) => f.name || f.id;

/**
 * 计算本地与远端的合并差异计划（不修改输入，不落库）。
 * @param local 本地全量 payload
 * @param remote 远端解密后 payload
 */
export function computeMergePlan(local: SyncPayload, remote: SyncPayload): Omit<MergePlan, 'hasLocalUnpushed'> {
  return {
    connections: diffSection(local.connections, remote.connections, connLabel, connDetail),
    queries: diffSection(local.queries, remote.queries, queryLabel),
    folders: diffSection(local.queryFolders, remote.queryFolders, folderLabel),
    history: diffHistory(local.history, remote.history),
  };
}

/** 各分段变化总数（用于判断是否有变更需预览） */
export function totalChanges(plan: Omit<MergePlan, 'hasLocalUnpushed'>): number {
  return (
    plan.connections.added + plan.connections.updated + plan.connections.deleted +
    plan.queries.added + plan.queries.updated + plan.queries.deleted +
    plan.folders.added + plan.folders.updated + plan.folders.deleted +
    plan.history.added
  );
}

/** 各分段 localOnly 总数（用于「本地有未推送」判定） */
export function totalLocalOnly(plan: Omit<MergePlan, 'hasLocalUnpushed'>): number {
  return plan.connections.localOnly + plan.queries.localOnly + plan.folders.localOnly;
}
