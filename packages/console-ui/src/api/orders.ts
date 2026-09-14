import { getAccessToken } from './tokenStore';
import { authedFetch, type FetchLike } from './authedFetch';
import { readServerError } from './serverError';

/**
 * 支付订单 API 客户端（P4 切片 3）。只读（列表/详情）；下单（POST）受支付网关
 * 门禁，未配置真网关时服务端 404，前端下单入口也随 product 能力关闭。
 */

export interface ConsoleOrder {
  orderNo: string;
  planCode: string;
  amountCents: number;
  channel: string;
  status: string;
  paidTime: string | null;
  expiresTime: string;
  createTime: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type Result<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'failure'; code?: string; message?: string };

function auth(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

function qs(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function failure(res: Response): Promise<{ kind: 'unauthorized' } | { kind: 'forbidden' } | { kind: 'not-found' } | { kind: 'failure'; code?: string; message?: string }> {
  const status = res.status;
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'not-found' };
  const err = await readServerError(res);
  return { kind: 'failure', code: err?.code, message: err?.message };
}

export async function listOrders(
  cursor?: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<Page<ConsoleOrder>>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/console/orders${qs({ cursor })}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) {
      const body = (await res.json()) as Page<ConsoleOrder>;
      return { kind: 'ok', value: body };
    }
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

export async function getOrder(
  orderNo: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<ConsoleOrder>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/console/orders/${encodeURIComponent(orderNo)}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as ConsoleOrder };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 支付参数：支付宝返回收银台跳转 URL；微信 native 返回扫码用的 code_url。 */
export interface PayParams {
  redirectUrl?: string;
  codeUrl?: string;
}

export interface CreateOrderResult {
  order: ConsoleOrder;
  payParams: PayParams;
}

/**
 * 下单（P4）：服务端按 plan_code 计价并做渠道 prepay，返回支付参数。
 * 下单不使用 Idempotency-Key（与后端语义一致），但需 CSRF token（会话绑定写）。
 * 支付功能关闭/渠道未配置时服务端 503，前端按 failure 处理。
 */
export async function createOrder(
  planCode: string,
  channel: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<Result<CreateOrderResult>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/console/orders',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ planCode, channel }),
      },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()) as CreateOrderResult };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}