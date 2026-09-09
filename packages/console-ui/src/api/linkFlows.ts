/**
 * 一次性邮件链接 API 封装（P3 §5，切片 1）。
 *
 * 原 token 只出现在认领请求 body 里，消费完全由 HttpOnly link-flow cookie 驱动 ——
 * 前端不读取、不持久化、也不把 token 放进任何路径/日志。
 * 所有请求显式携带 `Accept: application/json`（§5.1）；写请求带 JSON body 时携带
 * `Content-Type: application/json`（§6）。匿名 CSRF token 由页面先 GET 后回显到
 * `X-CSRF-Token`。
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ClaimResult = { kind: 'ok' } | { kind: 'invalid' } | { kind: 'failure' };

export type VerifyEmailResult =
  | { kind: 'success' }
  | { kind: 'already-confirmed' }
  | { kind: 'invalid' }
  | { kind: 'failure' };

export type ResendResult =
  | { kind: 'ok' }
  | { kind: 'rate-limited'; retryAfter: number }
  | { kind: 'failure' };

export interface AcceptInvitationOrganization {
  organizationId: string;
  name: string;
  status: string;
  closedTime: string | null;
  role: string;
}

export type AcceptInvitationResult =
  | { kind: 'success'; organization: AcceptInvitationOrganization }
  | { kind: 'already-accepted'; organization: AcceptInvitationOrganization }
  | { kind: 'invalid' }
  | { kind: 'unauthorized' }
  | { kind: 'failure' };

export type BindMailFlowResult =
  | { kind: 'ok' }
  | { kind: 'invalid' }
  | { kind: 'unauthorized' }
  | { kind: 'failure' };

function jsonHeaders(csrfToken?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

function acceptHeaders(csrfToken?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

/** 认领：以 token possession 换取短时 link-flow cookie。422 = 链接形态/类型无效。 */
export async function claimLinkFlow(
  type: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<ClaimResult> {
  try {
    const res = await fetchImpl('/api/public/link-flows', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ type, token }),
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 422) return { kind: 'invalid' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

/** 消费：浏览器不再提交原始 token，凭 link-flow cookie 定位 + 匿名 CSRF 双提交。 */
export async function verifyEmail(csrfToken: string, fetchImpl: FetchLike = fetch): Promise<VerifyEmailResult> {
  try {
    const res = await fetchImpl('/api/public/link-flows/verify-email', {
      method: 'POST',
      headers: acceptHeaders(csrfToken),
    });
    if (res.ok) return { kind: 'success' };
    if (res.status === 409) return { kind: 'already-confirmed' };
    if (res.status === 401) return { kind: 'invalid' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

/** 匿名重发（防枚举：不区分邮箱是否存在/已验证，响应恒成功）。 */
export async function resendVerification(
  email: string,
  csrfToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<ResendResult> {
  try {
    const res = await fetchImpl('/api/public/link-flows/resend-verification', {
      method: 'POST',
      headers: jsonHeaders(csrfToken),
      body: JSON.stringify({ email }),
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? 60);
      return { kind: 'rate-limited', retryAfter: Number.isFinite(retryAfter) ? retryAfter : 60 };
    }
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

/** 接受组织邀请（console-only，§5.3）：凭 link-flow cookie + Bearer + 会话绑定 CSRF。 */
export async function acceptInvitation(
  csrfToken: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<AcceptInvitationResult> {
  try {
    const res = await fetchImpl('/api/console/link-flows/accept-invitation', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.ok) return { kind: 'success', organization: (await res.json()).organization };
    if (res.status === 409) return { kind: 'already-accepted', organization: (await res.json()).organization };
    if (res.status === 400) return { kind: 'invalid' };
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

/** 把 held mail-flow 显式绑定到当前登录用户（§5.3 消费前置条件）。绑定成功后方可消费。 */
export async function bindMailFlow(
  csrfToken: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<BindMailFlowResult> {
  try {
    const res = await fetchImpl('/api/console/link-flows/bind', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (res.ok) return { kind: 'ok' };
    if (res.status === 400) return { kind: 'invalid' };
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}