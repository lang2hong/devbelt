/**
 * 连接串凭据处理（供「不含密码」导出使用）。
 *
 * `mysql://user:password@host:3306/db` 这类连接串会把密码内嵌在 URL 里，
 * 若只删除 `password`/`sshPassword` 字段会在导出时旁路泄漏。这里负责识别并剥离。
 */

/** 连接串是否内嵌了凭据（用户名或密码）。解析失败视为无。 */
export function hasUrlCredentials(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/**
 * 剥离连接串内嵌的密码（保留用户名与其它部分）。
 * 解析失败或无凭据则原样返回，避免把非法/相对串改坏。
 */
export function stripUrlCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.password === '' && u.username === '') return url;
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}