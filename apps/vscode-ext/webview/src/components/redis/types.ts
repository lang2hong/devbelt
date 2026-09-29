import type { RedisMonitorMetrics, RedisPanel, RedisValueData } from '../../../../src/result/protocol';

export type { RedisMonitorMetrics, RedisPanel, RedisValueData };

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