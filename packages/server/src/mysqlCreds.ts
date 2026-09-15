export interface MysqlCreds {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * env → MySQL 连接参数的**单一来源**。
 *
 * 服务端组合根（`config.ts`）与提权 CLI（`scripts/promotePlatformAdmin.ts`）
 * 过去各自手写这套默认值，任一处漂移都会让脚本连到与进程不同的库。
 * 本模块无副作用（不解析签名密钥），可被只关心连库的脚本安全复用。
 */
export function resolveMysqlCreds(env: NodeJS.ProcessEnv): MysqlCreds {
  return {
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'dbclient',
    password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'db_client',
  };
}