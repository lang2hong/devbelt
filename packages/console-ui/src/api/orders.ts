import { getAccessToken } from './tokenStore';
import { authedFetch, type FetchLike } from './authedFetch';
import { resolveErrorKind } from './httpError';

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
  | { kind: 'failure' };

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

async function failure(res: Response): Promise<{ kind: 'unauthorized' } | { kind: 'forbidden' } | { kind: 'not-found' } | { kind: 'failure' }> {
  const k = await resolveErrorKind(res);
  if (k === 'unauthorized') return { kind: 'unauthorized' };
  if (k === 'forbidden') return { kind: 'forbidden' };
  if (k === 'not-found') return { kind: 'not-found' };
  return { kind: 'failure' };
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