/**
 * Redis 拓扑解析与 SSH NAT map（P7 S4）。
 *
 * 纯函数、零 IO，便于对**真实回包形状**过测：
 *  - `parseClusterNodesMasters`：解析 `CLUSTER NODES` 文本，取各 master 的 `host:port`；
 *  - `parseSentinelMasterAddr`：解析 `SENTINEL get-master-addr-by-name` 的 `[host, port]`；
 *  - `buildNatMap`：把「远端地址 → 本地隧道端口」编成 ioredis `natMap`。
 *
 * SSH+Cluster/Sentinel 的隧道复用现有 `SshTunnel.create`（用**合成 conn id** 为每个目标节点
 * 建独立隧道），不重构既有单隧道 API，避免影响 SQL SSH 路径。
 */

export interface RedisHostPort {
  host: string;
  port: number;
}

interface ClusterNodeLine {
  host: string;
  port: number;
  flags: string[];
}

/** 解析一行 `id addr flags ...`；addr 形如 `127.0.0.1:30001@31001[,hostname=`。 */
function parseClusterNodeLine(line: string): ClusterNodeLine | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const addr = parts[1].split('@')[0].split(',')[0];
  const idx = addr.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = addr.slice(0, idx);
  const port = Number(addr.slice(idx + 1));
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host, port, flags: parts[2].split(',') };
}

/**
 * `CLUSTER NODES` → master 节点（含 `master` flag，排除 `fail`）。
 * @param text 原始文本回复（每行一个节点）
 */
export function parseClusterNodesMasters(text: string): RedisHostPort[] {
  const out: RedisHostPort[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const node = parseClusterNodeLine(line);
    if (!node) continue;
    // `fail`/`fail?`（疑似失联）都排除。
    if (!node.flags.includes('master') || node.flags.some((f) => f.startsWith('fail'))) continue;
    const key = `${node.host}:${node.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: node.host, port: node.port });
  }
  return out;
}

/**
 * `CLUSTER NODES` → **全部非失败节点**（master + replica）。
 *
 * 只映射 master 会让副本/故障转移后的新 master/MOVED 目标绕过 SSH：ioredis 直连内网地址并发送 AUTH。
 * 所以隧道与 natMap 覆盖全部非失败节点（未知节点仍会回退真地址——已知用 object 形式时 ioredis 的
 * 种子 `127.0.0.1` 依赖该回退，故此处不做"未知即抛"）。
 */
export function parseClusterNodesAll(text: string): RedisHostPort[] {
  const out: RedisHostPort[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const node = parseClusterNodeLine(line);
    if (!node) continue;
    if (node.flags.some((f) => f.startsWith('fail'))) continue;
    const key = `${node.host}:${node.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host: node.host, port: node.port });
  }
  return out;
}

/** `SENTINEL get-master-addr-by-name` 回复 → `{host,port}`；无 master 返回 null。 */
export function parseSentinelMasterAddr(reply: unknown): RedisHostPort | null {
  if (!Array.isArray(reply) || reply.length < 2) return null;
  const host = String(reply[0] ?? '');
  const port = Number(reply[1]);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host, port };
}

export interface NatMapEntry {
  remoteHost: string;
  remotePort: number;
  localPort: number;
}

/** ioredis Cluster `natMap`：`address → {host,port}`；返回 undefined 表示按原地址。 */
export type NatMapFn = (address: string) => RedisHostPort | null;

export interface NatMapOptions {
  /** 未映射地址回调（仅日志/提示，纯函数不在此抛错）。 */
  onUnmapped?: (address: string) => void;
}

/**
 * 未映射节点统一映射到的「死端口」。
 *
 * **不能用 0**：ioredis/Node 会把 `port: 0` 当作未设置并回退默认 6379，反而连到本机 6379 上的
 * 其它进程（可能回成功，且会把 AUTH 发过去）——实测在 CI 上命中过本机 standalone Redis。
 * 用 1（tcpmux，正常情况下永不监听）：连接立即 `ECONNREFUSED`，有界失败且不发往任何真服务。
 */
export const UNMAPPED_DEAD_PORT = 1;

/**
 * 远端地址 → 本地隧道端口（**函数形式**）。
 *
 * 未知节点不能回退真地址——扩容/resharding 后的新内网节点会绕过隧道被 ioredis 直连并发 AUTH。
 * 也**绝不能抛错**：ioredis 在 CLUSTER SLOTS 回调与 MOVED/ASK 处理里调用 natMapper，抛错会变成
 * 未捕获异常并让 slot 刷新永久卡住 / 命令永不 settle（N1）。
 * 且**不豁免 loopback**（ioredis 的 startupNodes 不走 natMapper，种子节点无需豁免）：一律映射到
 * 必然被拒的本地死端口（127.0.0.1:0），连接失败可控且可诊断，绝不把 AUTH 发往本机其它进程。
 */
export function buildNatMap(entries: readonly NatMapEntry[], opts: NatMapOptions = {}): NatMapFn {
  const map = new Map<string, RedisHostPort>();
  for (const e of entries) {
    map.set(`${e.remoteHost}:${e.remotePort}`, { host: '127.0.0.1', port: e.localPort });
  }
  return (address: string) => {
    const hit = map.get(address);
    if (hit) return hit;
    opts.onUnmapped?.(address);
    return { host: '127.0.0.1', port: UNMAPPED_DEAD_PORT }; // 死端口：连接必败，绝不把 AUTH 发往任何真地址
  };
}

/** 未映射 node 的日志/提示回调。 */
export interface UnmappedNodeReporter {
  /** 记日志（**按地址限流**：每个地址只记一次，避免每次 slot 刷新刷屏）。 */
  log: (address: string) => void;
  /** 提示用户（同一连接只调用一次，避免 slot 刷新刷屏）。 */
  notifyOnce: (address: string) => void;
}

/**
 * 构造去重上报器：`log` 按地址只记一次；`notifyOnce` 每个连接只调一次。
 * 纯逻辑、无 vscode 依赖，便于单测；由 `extension.ts` 注入真正的 diag/提示实现。
 * 重连时由扩展丢弃旧 reporter 重建，限流随之重置。
 */
export function createUnmappedNodeReporter(
  log: (address: string) => void,
  notify: (address: string) => void,
): UnmappedNodeReporter {
  let notified = false;
  const logged = new Set<string>();
  return {
    log: (address: string) => {
      if (logged.has(address)) return;
      logged.add(address);
      log(address);
    },
    notifyOnce: (address: string) => {
      if (notified) return;
      notified = true;
      notify(address);
    },
  };
}
