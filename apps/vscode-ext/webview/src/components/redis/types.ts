import type { RedisMonitorMetrics, RedisPanel, RedisValueData, RedisMoreToken } from '../../../../src/result/protocol';

export type { RedisMonitorMetrics, RedisPanel, RedisValueData, RedisMoreToken };

/** 续页回贴载荷（host collectionMoreResult 的文本 + 并行 base64 子集；仅含二进制页携带字节）。 */
export interface CollectionPagePayload {
  kind: RedisValueData['kind'];
  entries?: [string, string][];
  entryBytes?: [string, string][];
  /** list → string[]；zset → [member, score][]（随 kind 变化）。 */
  items?: string[] | [string, string][];
  itemBytes?: string[] | [string, string][];
  members?: string[];
  memberBytes?: string[];
}

/**
 * 集合续页合并（R1 修复）：文本与并行 base64 **同序同长**追加。
 * - 页内有二进制项 → 直接拼接（首屏无字节数组时先补 `''` 占位，视图按 falsy 视为无字节）；
 * - 页内全文本：两侧都无字节 → 不建数组；既有有字节 → 新项补 `''` 占位保持索引对齐。
 */
export function appendCollectionPage(data: RedisValueData, msg: CollectionPagePayload): RedisValueData {
  if (data.kind === 'hash' && msg.entries) {
    const entryBytes = appendAligned(data.entryBytes, data.entries.length, msg.entries.length, msg.entryBytes, () => ['', ''] as [string, string]);
    return { ...data, entries: [...data.entries, ...msg.entries], ...(entryBytes ? { entryBytes } : {}) };
  }
  if (data.kind === 'list' && msg.items) {
    const items = msg.items as string[];
    const itemBytes = appendAligned(data.itemBytes, data.items.length, items.length, msg.itemBytes as string[] | undefined, () => '');
    return { ...data, items: [...data.items, ...items], ...(itemBytes ? { itemBytes } : {}) };
  }
  if (data.kind === 'set' && msg.members) {
    const memberBytes = appendAligned(data.memberBytes, data.members.length, msg.members.length, msg.memberBytes, () => '');
    return { ...data, members: [...data.members, ...msg.members], ...(memberBytes ? { memberBytes } : {}) };
  }
  if (data.kind === 'zset' && msg.items) {
    const items = msg.items as [string, string][];
    const itemBytes = appendAligned(data.itemBytes, data.items.length, items.length, msg.itemBytes as [string, string][] | undefined, () => ['', ''] as [string, string]);
    return { ...data, items: [...data.items, ...items], ...(itemBytes ? { itemBytes } : {}) };
  }
  return data;
}

/** 对齐追加：两侧都无 → 不建数组；任一侧有 → 缺项补占位（`''` 视为无字节，视图按 falsy 处理）。 */
function appendAligned<T>(prev: T[] | undefined, prevLen: number, nextLen: number, next: T[] | undefined, placeholder: () => T): T[] | undefined {
  if (!prev && !next) return undefined;
  const base = prev ?? Array.from({ length: prevLen }, placeholder);
  return next ? [...base, ...next] : [...base, ...Array.from({ length: nextLen }, placeholder)];
}

export interface CommandResult {
  id: string;
  command: string;
  ok: boolean;
  result: string;
  costMs: number;
  error: string | null;
}

export interface SlowlogEntry {
  id: number;
  timestamp: number;
  durationMicros: number;
  command: string;
  clientAddr: string;
  clientName: string;
}

/** 选中 key 的值快照（host → webview）。 */
export interface ValueInfo {
  key: string;
  keyType: string;
  ttl: number;
  tooLarge: boolean;
  size: number | null;
  data: RedisValueData | null;
  /** H5：键名解码有损（非 UTF-8）→ 只读。 */
  keyBinary?: boolean;
  /** H5：值里解码有损的字段/成员/元素 → 这些项只读。 */
  binaryFields?: string[];
  /** 集合续页 token（hash/list/set/zset；stream 走独立通道）。 */
  more?: RedisMoreToken;
}

/** keyBrowser 面板 = 纯值查看/编辑（键导航在 explorer 树侧）。 */
export function isKeyBrowserPanel(panel: RedisPanel): boolean {
  return panel === 'keyBrowser';
}

/**
 * Stream 是否已加载完（可续页判定）。
 * 精确判据：`entries.length >= XLEN(len)`；非 stream 数据恒为 done。
 * 注意：XRANGE 的 COUNT 是硬上限，未满一页即区间耗尽。
 */
export function computeStreamDone(data: RedisValueData | null | undefined): boolean {
  if (data?.kind !== 'stream') return true;
  return data.entries.length >= data.len;
}