import { getAccessToken } from '@devbelt/auth-client';
import { authedFetch } from '@devbelt/auth-client';
import type { FetchLike } from '@devbelt/auth-client';
import type { PlanCatalog } from '../lib/planFeatures';

/** /api/db/console/plans：个人套餐目录（认证，只读）。 */

export type PlansResult = { kind: 'ok'; value: PlanCatalog } | { kind: 'unauthorized' } | { kind: 'failure' };

export async function listPlans(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<PlansResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/db/console/plans',
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()) as PlanCatalog };
    if (res.status === 401) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}