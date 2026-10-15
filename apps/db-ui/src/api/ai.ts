import { getAccessToken } from '@devbelt/auth-client';
import { authedFetch, type FetchLike } from '@devbelt/auth-client';
import { readServerError } from '@devbelt/auth-client';

/**
 * AI 加油包 API 客户端（P9.1c）：档位目录 / 双段配额快照 / 用户侧下单。
 * 下单（POST）走 CSRF 写守卫；订单状态轮询复用 orders.ts 的 `getOrder`。
 */

export interface AiTopupSku {
  code: string;
  label: { en: string; zh: string };
  tokens: number;
  priceCents: number;
  validDays: number;
  status: 'active' | 'disabled';
  sortOrder: number;
}

export interface AiUsageSnapshot {
  usageMonth: string;
  limit: number;
  used: number;
  reserved: number;
  monthlyRemaining: number;
  topupRemaining: number;
  remaining: number;
  requestCount: number;
  resetAt: string;
}

export interface AiTopupOrderResult {
  orderNo: string;
  userId: number;
  purpose: 'topup';
  planCode: string | null;
  skuCode: string;
  amountCents: number;
  channel: string;
  status: string;
  paidTime: string | null;
  expiresTime: string;
  createTime: string;
}

export type AiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'failure'; code?: string; message?: string };

function auth(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

async function failure(res: Response): Promise<Exclude<AiResult<unknown>, { kind: 'ok' }>> {
  const status = res.status;
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'not-found' };
  const err = await readServerError(res);
  return { kind: 'failure', code: err?.code, message: err?.message };
}

/** 上架档位（购买页展示）。 */
export async function listAiSkus(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<AiResult<{ items: AiTopupSku[] }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/ai/skus', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as { items: AiTopupSku[] } };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 双段配额快照（账户页两段配额条）。 */
export async function getAiUsage(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<AiResult<AiUsageSnapshot>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/ai/usage', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as AiUsageSnapshot };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}

/** 用户侧下单（金额以服务端 SKU 为准，前端只传档位 + 渠道）。 */
export async function createAiTopupOrder(
  input: { skuCode: string; channel: 'wechat' | 'alipay'; mode?: 'qr' | 'redirect' },
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<AiResult<{ order: AiTopupOrderResult; payParams: { redirectUrl?: string; codeUrl?: string } }>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/ai/topup-orders',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(input.mode ? input : { skuCode: input.skuCode, channel: input.channel }),
      },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()) as { order: AiTopupOrderResult; payParams: { redirectUrl?: string; codeUrl?: string } } };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}