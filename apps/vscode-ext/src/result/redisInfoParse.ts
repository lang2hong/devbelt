import type { RedisMonitorMetrics } from './protocol';

/** INFO 值映射里取数字（缺失/非法 → 0）。 */
function num(map: Map<string, string>, key: string): number {
  const value = Number(map.get(key));
  return Number.isFinite(value) ? value : 0;
}

/** INFO 值映射里取字符串。 */
function str(map: Map<string, string>, key: string): string {
  return map.get(key) ?? '';
}

/**
 * 解析 `INFO` 文本为监控指标（纯函数，可单测）。
 *
 * 只读 `key:value` 行；`# Section` 与空行忽略。`dbN:keys=..,expires=..` 归入 keyspace。
 */
export function parseRedisInfo(text: string, ts = Date.now()): RedisMonitorMetrics {
  const map = new Map<string, string>();
  const keyspace: { db: string; keys: number; expires: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx);
    const value = trimmed.slice(idx + 1);
    if (/^db\d+$/.test(name)) {
      const kv = new Map<string, string>();
      for (const part of value.split(',')) {
        const eq = part.indexOf('=');
        if (eq >= 0) kv.set(part.slice(0, eq), part.slice(eq + 1));
      }
      keyspace.push({ db: name, keys: Number(kv.get('keys')) || 0, expires: Number(kv.get('expires')) || 0 });
    }
    map.set(name, value);
  }
  const hits = num(map, 'keyspace_hits');
  const misses = num(map, 'keyspace_misses');
  const total = hits + misses;
  keyspace.sort((a, b) => a.db.localeCompare(b.db));
  return {
    ts,
    version: str(map, 'redis_version'),
    role: str(map, 'role'),
    uptimeSeconds: num(map, 'uptime_in_seconds'),
    connectedClients: num(map, 'connected_clients'),
    usedMemory: num(map, 'used_memory'),
    usedMemoryHuman: str(map, 'used_memory_human'),
    maxmemory: num(map, 'maxmemory'),
    fragmentationRatio: num(map, 'mem_fragmentation_ratio'),
    instantaneousOpsPerSec: num(map, 'instantaneous_ops_per_sec'),
    instantaneousInputKbps: num(map, 'instantaneous_input_kbps'),
    instantaneousOutputKbps: num(map, 'instantaneous_output_kbps'),
    totalCommandsProcessed: num(map, 'total_commands_processed'),
    evictedKeys: num(map, 'evicted_keys'),
    expiredKeys: num(map, 'expired_keys'),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    hitRate: total > 0 ? hits / total : null,
    keyspace,
  };
}

/**
 * 聚合多个 master 的采样（cluster 监控）：计数类求和、内存/流量/ops 求和、
 * 命中率用聚合 hits/misses 重算、keyspace 按 db 合并、uptime/碎片率取最大、role 置 `cluster`。
 * 纯函数，可单测。
 */
export function aggregateRedisInfo(list: RedisMonitorMetrics[], ts = Date.now()): RedisMonitorMetrics {
  if (list.length === 0) return parseRedisInfo('', ts);
  if (list.length === 1) return { ...list[0], ts };
  const sum = (pick: (m: RedisMonitorMetrics) => number): number => list.reduce((acc, m) => acc + pick(m), 0);
  const hits = sum((m) => m.keyspaceHits);
  const misses = sum((m) => m.keyspaceMisses);
  const total = hits + misses;
  const ksMap = new Map<string, { keys: number; expires: number }>();
  for (const m of list) {
    for (const k of m.keyspace) {
      const cur = ksMap.get(k.db) ?? { keys: 0, expires: 0 };
      cur.keys += k.keys;
      cur.expires += k.expires;
      ksMap.set(k.db, cur);
    }
  }
  const keyspace = [...ksMap.entries()]
    .map(([db, v]) => ({ db, keys: v.keys, expires: v.expires }))
    .sort((a, b) => a.db.localeCompare(b.db));
  return {
    ts,
    version: list.find((m) => m.version)?.version ?? '',
    role: 'cluster',
    uptimeSeconds: Math.max(...list.map((m) => m.uptimeSeconds)),
    connectedClients: sum((m) => m.connectedClients),
    usedMemory: sum((m) => m.usedMemory),
    usedMemoryHuman: '',
    maxmemory: sum((m) => m.maxmemory),
    fragmentationRatio: Math.max(...list.map((m) => m.fragmentationRatio)),
    instantaneousOpsPerSec: sum((m) => m.instantaneousOpsPerSec),
    instantaneousInputKbps: sum((m) => m.instantaneousInputKbps),
    instantaneousOutputKbps: sum((m) => m.instantaneousOutputKbps),
    totalCommandsProcessed: sum((m) => m.totalCommandsProcessed),
    evictedKeys: sum((m) => m.evictedKeys),
    expiredKeys: sum((m) => m.expiredKeys),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    hitRate: total > 0 ? hits / total : null,
    keyspace,
  };
}