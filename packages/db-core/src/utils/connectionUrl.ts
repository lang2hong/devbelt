/**
 * 改写连接串里的**库名**，保留其余部分（host/port/凭据/query，含 `?sslmode=`）。
 *
 * PG 多库的衍生会话：连接以 URL 配置时（`useConnectionString`），只改配置里的
 * `database` 字段驱动仍会连 URL 里的库；必须同步改写 URL，才能真正连到目标库。
 */
export function withDatabaseInUrl(rawUrl: string, database: string): string {
  const url = new URL(rawUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}