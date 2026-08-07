/**
 * 服务端配置：从环境变量读取，提供默认值。
 */
export const config = {
  /** 服务端口 */
  port: Number(process.env.PORT || 3000),
  /** JWT 签名密钥（生产必须通过环境变量注入） */
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  /** JWT 过期时间 */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  /** MySQL 连接配置 */
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'dbclient',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'db_client',
  },
};