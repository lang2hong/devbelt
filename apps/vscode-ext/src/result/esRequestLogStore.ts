/**
 * ES 请求日志缓冲（S4 命令日志面板）。
 *
 * EsClient 的 `onLog` 回调按连接汇入这里；面板订阅后增量渲染。
 * 仅保留最近 500 条（对齐 Redis 命令日志的量级），不落盘。
 */
export interface EsRequestLogEntry {
  method: string;
  path: string;
  status: number;
  tookMs: number;
  time: number;
  error?: string;
}

const MAX = 500;
const buffers = new Map<string, EsRequestLogEntry[]>();
const listeners = new Map<string, Set<(entry: EsRequestLogEntry) => void>>();

/** buildEsSession 的 EsClient onLog 钩子。 */
export function recordEsRequest(connId: string, entry: EsRequestLogEntry): void {
  const list = buffers.get(connId) ?? [];
  list.push(entry);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  buffers.set(connId, list);
  for (const fn of listeners.get(connId) ?? []) fn(entry);
}

/** 快照（面板挂载/切到日志 tab 时拉取）。 */
export function getEsRequestLog(connId: string): EsRequestLogEntry[] {
  return [...(buffers.get(connId) ?? [])];
}

/** 连接关闭/删除时回收该连接的缓冲与订阅（避免无界增长）。 */
export function clearEsRequestLog(connId: string): void {
  buffers.delete(connId);
  listeners.delete(connId);
}

/** 订阅增量（返回取消函数）。 */
export function subscribeEsRequestLog(connId: string, fn: (entry: EsRequestLogEntry) => void): () => void {
  const set = listeners.get(connId) ?? new Set();
  set.add(fn);
  listeners.set(connId, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(connId);
  };
}