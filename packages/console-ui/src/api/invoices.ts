import { getAccessToken } from './tokenStore';
import { authedFetch, type FetchLike } from './authedFetch';
import { resolveErrorKind, type FailureKind } from './httpError';

/**
 * 发票申请 API 客户端（P4 切片 3）。申请 = console 受控写（CSRF + Idempotency-Key），
 * 金额由服务端按订单金额取（前端不传金额）。
 */

export interface InvoiceRecord {
  invoiceId: string;
  title: string;
  taxNo: string | null;
  email: string;
  amountCents: number;
  status: string;
  reason: string | null;
  createTime: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type ListInvoicesResult =
  | { kind: 'ok'; value: Page<InvoiceRecord> }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'failure' };

export type RequestInvoiceResult =
  | { kind: 'ok'; value: InvoiceRecord }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'conflict' }
  | { kind: 'in-progress' }
  | { kind: 'bad-request' }
  | { kind: 'failure' };

function auth(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

function write(csrfToken: string, token: string, idempotencyKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey,
  };
}

function qs(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function failure(res: Response): Promise<{ kind: FailureKind }> {
  return { kind: await resolveErrorKind(res) };
}

/** 把 FailureKind 收窄到只读列表允许的判别（列表不会产 conflict/in-progress/not-found）。 */
function readFailure(kind: { kind: FailureKind }): ListInvoicesResult {
  if (kind.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (kind.kind === 'forbidden') return { kind: 'forbidden' };
  return { kind: 'failure' };
}

export async function listInvoices(
  cursor?: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<ListInvoicesResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(`/api/db/console/invoices${qs({ cursor })}`, { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as Page<InvoiceRecord> };
    return readFailure(await failure(res));
  } catch {
    return { kind: 'failure' };
  }
}

export async function requestInvoice(
  orderNo: string,
  title: string,
  email: string,
  taxNo: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<RequestInvoiceResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/db/console/invoices',
      {
        method: 'POST',
        headers: write(csrfToken, token, idempotencyKey),
        body: JSON.stringify({ orderNo, title, email, taxNo }),
      },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()).invoice as InvoiceRecord };
    return failure(res);
  } catch {
    return { kind: 'failure' };
  }
}