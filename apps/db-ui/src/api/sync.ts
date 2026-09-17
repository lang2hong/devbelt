import { getAccessToken } from './tokenStore';
import { authedFetch, type FetchLike } from './authedFetch';

/**
 * 同步概览 API 客户端（P3 §6）。只读聚合元数据：不返回 record 密文/密钥/E2EE 材料。
 */

export interface SyncOverview {
  initialized: boolean;
  lastActivityTime: string | null;
  activeRecordCount: number;
  ciphertextBytes: number;
  recordLimit: number | null;
  storageLimit: number | null;
}

export type SyncOverviewResult =
  | { kind: 'ok'; value: SyncOverview }
  | { kind: 'unauthorized' }
  | { kind: 'failure' };

export async function syncOverview(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<SyncOverviewResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      '/api/db/console/sync/overview',
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
      fetchImpl,
    );
    if (res.ok) return { kind: 'ok', value: (await res.json()) as SyncOverview };
    if (res.status === 401) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}