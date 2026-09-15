export interface MysqlCreds {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * env → MySQL 连接参数的**单一来源**。
 *
 * 服务端组合根（`config.ts`）与提权 CLI（`scripts/promotePlatformAdmin.ts`）
 * 过去各自手写这套默认值，任一处漂移都会让脚本连到与进程不同的库。
 * 本模块无副作用（不解析签名密钥），可被只关心连库的脚本安全复用。
 *
 * fail-fast：非本地主机 + 空密码默认拒绝启动，避免「生产漏配密码 → 以空密码连库」。
 * 本地回环（127.0.0.1/::1/localhost）与显式 `MYSQL_ALLOW_EMPTY_PASSWORD=1` 放行。
 */
export function resolveMysqlCreds(env: NodeJS.ProcessEnv): MysqlCreds {
  const host = env.MYSQL_HOST || '127.0.0.1';
  const password = env.MYSQL_PASSWORD || '';
  if (!password && !LOCAL_HOSTS.has(host) && env.MYSQL_ALLOW_EMPTY_PASSWORD !== '1') {
    throw new Error(
      `MYSQL_PASSWORD is empty for non-local host ${JSON.stringify(host)}; refusing to start. ` +
        `Set MYSQL_PASSWORD, or set MYSQL_ALLOW_EMPTY_PASSWORD=1 to explicitly allow an empty password.`,
    );
  }
  return {
    host,
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'dbclient',
    password,
    database: env.MYSQL_DATABASE || 'db_client',
  };
}