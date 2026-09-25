/**
 * Redis over SSH 的隧道编排（P7 S4）。
 *
 * 复用现有 `SshTunnel.create`（以**合成 conn id** 为每个目标节点建独立隧道），
 * 不重构其单隧道 API，避免影响 SQL SSH 路径：
 *  - Cluster：经种子隧道 `CLUSTER NODES` 取各 master → 逐 master 建隧道 → NAT map；
 *  - Sentinel：经种子隧道 `SENTINEL get-master-addr-by-name` 发现 master → 建隧道到 master。
 */
import { RedisClient, type RedisTlsOptions } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { SshTunnel } from './sshTunnel';
import {
  buildNatMap,
  parseClusterNodesMasters,
  parseSentinelMasterAddr,
  type RedisHostPort,
} from './redisTopology';

export interface RedisAuth {
  username?: string;
  password?: string;
  /** Sentinel 节点认证（与 master 密码可不同）。 */
  sentinelPassword?: string;
  tls?: RedisTlsOptions;
  connectTimeout?: number;
}

function probe(host: string, port: number, auth: RedisAuth): RedisClient {
  return new RedisClient({
    host,
    port,
    username: auth.username,
    password: auth.password,
    tls: auth.tls,
    connectTimeout: auth.connectTimeout,
    readOnly: true,
  });
}

/** Sentinel 节点认证：优先 sentinelPassword，回退 master 密码。 */
function probeSentinel(host: string, port: number, auth: RedisAuth): RedisClient {
  return probe(host, port, { ...auth, password: auth.sentinelPassword ?? auth.password });
}

export interface ClusterTunnelSetup {
  seedNodes: RedisHostPort[];
  natMap: Record<string, RedisHostPort>;
  /** 合成隧道 id，close 时逐个回收。 */
  tunnelIds: string[];
}

/** 经种子隧道发现 cluster master 并逐节点建隧道，返回 natMap。 */
export async function setupClusterOverSsh(
  conn: SavedConnection,
  seedLocalPort: number,
  auth: RedisAuth,
): Promise<ClusterTunnelSetup> {
  const client = probe('127.0.0.1', seedLocalPort, auth);
  let masters: RedisHostPort[];
  try {
    await client.connect();
    const raw = await client.sendCommand('CLUSTER', ['NODES']);
    masters = parseClusterNodesMasters(String(raw));
  } finally {
    await client.close();
  }
  if (!masters.length) throw new Error('CLUSTER NODES 未返回任何 master 节点');

  const tunnelIds: string[] = [];
  const entries: { remoteHost: string; remotePort: number; localPort: number }[] = [];
  try {
    for (let i = 0; i < masters.length; i++) {
      const m = masters[i];
      const id = `${conn.id}#nat${i}`;
      const localPort = await SshTunnel.create({ ...conn, id, host: m.host, port: m.port });
      // 有 sshHost 时 create 失败应 fail-fast：漏一条隧道会让 natMap 缺项、运行期才报错，极难排障。
      if (!localPort) throw new Error(`无法为 cluster 节点建立 SSH 隧道：${m.host}:${m.port}`);
      tunnelIds.push(id);
      entries.push({ remoteHost: m.host, remotePort: m.port, localPort });
    }
  } catch (err) {
    // 本函数自保证：失败前回收已建隧道（外层此时尚未接管 tunnelIds）。
    for (const id of tunnelIds) SshTunnel.close(id);
    throw err;
  }
  return { seedNodes: masters, natMap: buildNatMap(entries), tunnelIds };
}

export interface SentinelTunnelSetup {
  master: RedisHostPort;
  masterLocalPort: number;
  tunnelId: string;
}

/** 经种子隧道（指向某 sentinel）发现 master，并建隧道到 master。 */
export async function discoverSentinelMasterOverSsh(
  conn: SavedConnection,
  seedLocalPort: number,
  auth: RedisAuth,
): Promise<SentinelTunnelSetup> {
  const client = probeSentinel('127.0.0.1', seedLocalPort, auth);
  let master: RedisHostPort | null;
  try {
    await client.connect();
    const raw = await client.sendCommand('SENTINEL', ['get-master-addr-by-name', conn.sentinelName ?? '']);
    master = parseSentinelMasterAddr(raw);
  } finally {
    await client.close();
  }
  if (!master) throw new Error(`SENTINEL 未发现 master：${conn.sentinelName ?? ''}`);

  const tunnelId = `${conn.id}#sentinel-master`;
  const masterLocalPort = await SshTunnel.create({ ...conn, id: tunnelId, host: master.host, port: master.port });
  if (!masterLocalPort) throw new Error('无法为 Sentinel master 建立 SSH 隧道');
  return { master, masterLocalPort, tunnelId };
}
