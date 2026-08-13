/**
 * MySQL 连接的惰性访问类型。
 * repository 实现通过 getter 获取连接（app.ready 后才有值），
 * 使 createApp 可在路由注册阶段就构造 repo，运行时才取连接。
 */
export type MysqlDb = {
  database: string;
  query<T = any>(sql: string, params?: any[]): Promise<T>;
};
