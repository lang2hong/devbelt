/**
 * 邮箱验证 confirm 接口封装（P3-A）。
 *
 * 只做 path construction + fetch + 结果映射，纯函数、可注入 fetch，测试不触网。
 * token 属一次性敏感 URL 片段：仅按官方路径规则做 path segment 编码，不落日志、
 * 不持久化，也不发送到除该 confirm 端点外的任何地址。
 */
export type VerifyEmailResult =
  | { kind: 'success' }
  | { kind: 'invalid' }
  | { kind: 'failure'; reason: string };

export type ConfirmEmailFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ConfirmEmailOptions {
  /** 服务端 origin 前缀；缺省为相对路径，交由调用方 origin 决定。 */
  baseUrl?: string;
  fetchImpl?: ConfirmEmailFetch;
}

/** 构造 confirm 端点的 path（token 作为 path segment，需 encodeURIComponent）。 */
export function verificationUrlPath(token: string): string {
  return `/api/auth/email-verifications/${encodeURIComponent(token)}/confirm`;
}

/**
 * 调用匿名邮箱验证 confirm 接口。
 *
 * 判成功只认「HTTP 2xx 且 JSON 为 { ok: true }」；401（invalid or expired token）
 * 映射为 invalid（不可重试）；其余失败（网络异常 / 5xx / 非 JSON / 意外成功载荷）
 * 一律 fail closed 为 failure（可重试）。本函数不 throw。
 */
export async function confirmEmail(token: string, options: ConfirmEmailOptions = {}): Promise<VerifyEmailResult> {
  const { baseUrl = '', fetchImpl = fetch } = options;
  const path = verificationUrlPath(token);

  try {
    const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST' });
    if (res.status === 401) return { kind: 'invalid' };
    if (!res.ok) return { kind: 'failure', reason: `HTTP ${res.status}` };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'failure', reason: 'non-JSON response' };
    }
    return isOkBody(body) ? { kind: 'success' } : { kind: 'failure', reason: 'unexpected success payload' };
  } catch (e) {
    return { kind: 'failure', reason: e instanceof Error ? e.message : 'network error' };
  }
}

function isOkBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
}