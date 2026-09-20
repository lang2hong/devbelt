/**
 * 连接串凭据处理（供「不含密码」导出使用）。
 *
 * `mysql://user:password@host:3306/db` 这类连接串会把密码内嵌在 URL 里，
 * 若只删除 `password`/`sshPassword` 字段会在导出时旁路泄漏。这里负责识别并剥离。
 */

/** libpq/关键词 DSN 里的 `password=...`（值可带引号）。 */
const KEYWORD_PASSWORD = /(\bpassword\s*=\s*)('(?:[^']|'')*'|\S+)/i;
/** JDBC 形式的 `jdbc:mysql://user:pass@host/db`（捕获用户名，剥离时保留）。 */
const JDBC_CREDENTIALS = /^(jdbc:[a-z0-9]+:\/\/)([^:@/\s]+):[^@/\s]+@/i;

/**
 * 连接串是否内嵌了凭据（用户名或密码）。
 *
 * 覆盖三种形态：URL（`scheme://user:pass@…`）、libpq 关键词 DSN（`password=…`）、
 * JDBC（`jdbc:…://user:pass@…`）。后两者 `new URL()` 解析不出凭据，过去会漏判并原样导出。
 */
export function hasUrlCredentials(url: string): boolean {
  if (JDBC_CREDENTIALS.test(url) || KEYWORD_PASSWORD.test(url)) return true;
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/**
 * 剥离连接串内嵌的密码（保留用户名与其它部分）。
 * 覆盖 URL / libpq 关键词 DSN / JDBC；无法解析且未检测到凭据时原样返回，避免把串改坏。
 */
export function stripUrlCredentials(url: string): string {
  let out = url.replace(KEYWORD_PASSWORD, '$1***').replace(JDBC_CREDENTIALS, '$1$2@');
  try {
    const u = new URL(out);
    if (u.password === '' && u.username === '') return out;
    u.password = '';
    return u.toString();
  } catch {
    return out;
  }
}