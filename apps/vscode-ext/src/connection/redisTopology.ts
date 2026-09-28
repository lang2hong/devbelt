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

/** 远端地址 → 本地隧道端口，供 ioredis Cluster `natMap`。 */
export function buildNatMap(entries: readonly NatMapEntry[]): Record<string, RedisHostPort> {
  const out: Record<string, RedisHostPort> = {};
  for (const e of entries) {
    out[`${e.remoteHost}:${e.remotePort}`] = { host: '127.0.0.1', port: e.localPort };
  }
  return out;
}
