/**
 * Elasticsearch 会话装配（P8 S2；镜像 `buildRedisSession`）。
 *
 * SSH 隧道已由调用方（doConnect）统一建好（host/port 已是本地转发地址），本模块只构造
 * EsClient、GET / 探活、包成 `ElasticsearchConnectionSession`；任何失败抛错，由 doConnect
 * 统一回收隧道，与 SQL/Redis 分支同构。
 */
import { EsClient, esCapabilities, parseEsError } from '@devbelt/db-core';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { SshTunnel } from './sshTunnel';
import type { ElasticsearchConnectionSession } from './connectionSession';
import type { SessionBuildContext } from './sessionBuildContext';
import { esAuthOf, esProtocolOf, esTlsOf } from './esAuth';
import { recordEsRequest } from '../result/esRequestLogStore';

export async function buildEsSession(
  ctx: SessionBuildContext,
  conn: SavedConnection,
  host: string,
  port: number,
  generation: number,
  key: string,
  tunnelLease?: string,
): Promise<ElasticsearchConnectionSession> {
  const client = new EsClient({
    protocol: esProtocolOf(conn),
    host,
    port,
    pathPrefix: conn.esPathPrefix,
    auth: esAuthOf(conn),
    tls: esTlsOf(conn),
    timeoutMs: conn.requestTimeout,
    readOnly: conn.readOnly === true,
    // S4：请求日志汇入命令日志缓冲（面板按连接订阅）。
    onLog: (entry) => recordEsRequest(conn.id, entry),
  });
  try {
    const res = await client.ping();
    if (res.status >= 400) {
      // 不引 i18n：装配模块需在无 vscode 运行的测试中可加载，文案由上层展示。
      throw new Error(parseEsError(res.body)?.reason ?? `Elasticsearch connection failed (HTTP ${res.status})`);
    }
  } catch (err) {
    client.close();
    throw err;
  }

  // 建连期间用户关闭/删除该连接（或管理器整体销毁）：建成即销毁。
  if (ctx.disposing || ctx.generation(conn.id) !== generation) {
    client.close();
    throw new Error('connection was closed before it could be established');
  }

  const session: ElasticsearchConnectionSession = {
    kind: 'elasticsearch',
    capabilities: esCapabilities(conn.readOnly === true),
    es: client,
    connId: conn.id,
    isAlive: () => client.isAlive(),
    close: () => {
      client.close();
      ctx.forgetSession(key);
      ctx.clearDialectCaches(conn.id);
      if (conn.sshHost) SshTunnel.release(conn.id, tunnelLease);
    },
  };
  ctx.registerSession(key, session, { session, lastUsed: Date.now(), connId: conn.id, key });
  return session;
}