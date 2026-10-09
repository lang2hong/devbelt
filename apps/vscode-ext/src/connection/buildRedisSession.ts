/**
 * Redis 会话装配（P7 S2；从 `connectionManager.ts` 抽出，Phase 2 拆分）。
 *
 * SSH 隧道已由调用方（doConnect）统一建好（host/port 已是本地转发地址），本模块只构造
 * RedisClient、等 ready、包成 RedisConnectionSession；任何失败抛错，由 doConnect 统一
 * 回收隧道，与 SQL 分支同构。
 */
import { RedisClient, buildRedisTlsOptions } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { SshTunnel } from './sshTunnel';
import { discoverSentinelMasterOverSsh, setupClusterOverSsh } from './redisTunnel';
import type { RedisConnectionSession } from './connectionSession';
import type { SessionBuildContext } from './sessionBuildContext';

/** 解析 `host:port,host:port` 节点列表；缺省回退到 `defaultHost:defaultPort`。 */
function parseRedisNodes(raw: string | undefined, defaultHost: string, defaultPort: number): { host: string; port: number }[] {
  const items = (raw ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return [{ host: defaultHost, port: defaultPort }];
  return items.map((item) => {
    const idx = item.lastIndexOf(':');
    if (idx < 0) return { host: item, port: defaultPort };
    return { host: item.slice(0, idx), port: Number(item.slice(idx + 1)) || defaultPort };
  });
}

export async function buildRedisSession(
  ctx: SessionBuildContext,
  conn: SavedConnection,
  host: string,
  port: number,
  generation: number,
  key: string,
  tunnelLease?: string,
): Promise<RedisConnectionSession> {
  const mode = conn.redisMode ?? 'standalone';
  const tls = conn.useSSL
    ? buildRedisTlsOptions({
        caPath: conn.caPath,
        clientCertPath: conn.clientCertPath,
        clientKeyPath: conn.clientKeyPath,
        rejectUnauthorized: conn.rejectUnauthorized,
        // sentinel 模式：ioredis 会把这份 tls 应用到解析出的 master；servername 若填 sentinel
        // 主机名，master 的 SNI/证书校验会用错主机名导致连不上。留空让 tls 用 master 主机名。
        servername: mode === 'sentinel' ? undefined : conn.host,
      })
    : undefined;
  const common = {
    username: conn.user || undefined,
    password: conn.password,
    tls,
    connectTimeout: conn.connectTimeout,
    // Redis 命令超时跟随连接的 requestTimeout（过去固定 15s，用户配置无效）。
    commandTimeout: conn.requestTimeout,
    readOnly: conn.readOnly === true,
  };
  const auth = { username: conn.user || undefined, password: conn.password, sentinelPassword: conn.sentinelPassword, tls, connectTimeout: conn.connectTimeout };
  let extraTunnelIds: string[] = [];
  const closeExtraTunnels = (): void => { for (const id of extraTunnelIds) SshTunnel.close(id); };
  let started: RedisClient | undefined;
  try {
    if (mode === 'cluster') {
      if (conn.sshHost) {
        // 经种子隧道发现各 master 并逐节点建隧道 → NAT map（合成 conn id，回收见 close）。
        const setup = await setupClusterOverSsh(conn, port, auth, {
          onUnmapped: ctx.onRedisNodeUnmapped ? (address) => ctx.onRedisNodeUnmapped!(conn.id, address) : undefined,
        });
        extraTunnelIds = setup.tunnelIds;
        started = new RedisClient({
          ...common,
          cluster: { nodes: [{ host: '127.0.0.1', port }], natMap: setup.natMap, slotsRefreshTimeout: conn.connectTimeout ?? 3000 },
        });
      } else {
        const nodes = parseRedisNodes(conn.clusterNodes, host, port);
        started = new RedisClient({ ...common, cluster: { nodes, slotsRefreshTimeout: conn.connectTimeout ?? 3000 } });
      }
    } else if (mode === 'sentinel') {
      if (!conn.sentinelName) throw new Error('Redis Sentinel master 名称未配置');
      if (conn.sshHost) {
        const s = await discoverSentinelMasterOverSsh(conn, port, auth);
        extraTunnelIds = [s.tunnelId];
        started = new RedisClient({ ...common, host: '127.0.0.1', port: s.masterLocalPort, db: conn.redisDb });
      } else {
        const sentinels = parseRedisNodes(conn.sentinelNodes, host, port);
        started = new RedisClient({ ...common, sentinels, sentinelName: conn.sentinelName, sentinelPassword: conn.sentinelPassword, db: conn.redisDb });
      }
    } else {
      started = new RedisClient({ ...common, host, port, db: conn.redisDb });
    }
    await started.connect();
    // 探活：确认服务端可响应（只读模式下 PING 属读命令，不受影响）。
    await started.ping();
  } catch (err) {
    // 构造阶段抛错（如 opts 非法）时 started 可能仍未赋值：也要回收已建的合成隧道。
    if (started) { try { await started.close(); } catch { /* 保留原始错误 */ } }
    closeExtraTunnels();
    throw err;
  }
  const client = started;

  // 建连期间用户关闭/删除该连接（或管理器整体销毁）：建成即销毁。
  if (ctx.disposing || ctx.generation(conn.id) !== generation) {
    await client.close();
    // 建连期间被关闭：自毁时必须连同已建的合成隧道一起回收（否则 #nat*/#sentinel-master 泄漏）。
    closeExtraTunnels();
    throw new Error('connection was closed before it could be established');
  }

  const session: RedisConnectionSession = {
    kind: 'redis',
    client,
    db: client.isCluster ? 0 : (conn.redisDb ?? 0),
    mode,
    readOnly: conn.readOnly === true,
    isAlive: () => client.isAlive(),
    close: () => {
      void client.close();
      ctx.forgetSession(key);
      ctx.clearDialectCaches(conn.id);
      if (conn.sshHost) SshTunnel.release(conn.id, tunnelLease);
      closeExtraTunnels();
    },
  };
  ctx.registerSession(key, session, { session, lastUsed: Date.now(), connId: conn.id, key });
  return session;
}