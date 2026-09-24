import { getAccessToken } from '@devbelt/auth-client';
import { authedFetch, type FetchLike } from '@devbelt/auth-client';

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

export interface SyncE2eeParams {
  initialized: boolean;
  keyEpoch?: string;
  stateVersion?: string;
  changeSequence?: string;
  signPub?: string;
  smpKdf?: Record<string, unknown>;
  envelopeSmp?: Record<string, unknown>;
}

export interface CipherRecordDto {
  recordId: string;
  nonce?: string;
  ciphertext?: string;
  tag?: string;
  version: string;
  changeSequence: string;
  deleteTime?: string | null;
}

export interface SyncRecords {
  initialized: boolean;
  snapshotSequence: string;
  nextAfter?: string;
  records: CipherRecordDto[];
}

export type SimpleResult<T> = { kind: 'ok'; value: T } | { kind: 'unauthorized' } | { kind: 'failure' };

async function getJson<T>(path: string, token: string | null, fetchImpl: FetchLike): Promise<SimpleResult<T>> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(path, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, fetchImpl);
    if (res.ok) return { kind: 'ok', value: (await res.json()) as T };
    if (res.status === 401) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

export function getE2eeParams(token: string | null = getAccessToken(), fetchImpl: FetchLike = fetch): Promise<SimpleResult<SyncE2eeParams>> {
  return getJson<SyncE2eeParams>('/api/db/console/sync/e2ee-params', token, fetchImpl);
}

export function getSyncRecords(after: string, limit = 256, token: string | null = getAccessToken(), fetchImpl: FetchLike = fetch): Promise<SimpleResult<SyncRecords>> {
  const qs = `after=${encodeURIComponent(after)}&limit=${encodeURIComponent(String(limit))}`;
  return getJson<SyncRecords>(`/api/db/console/sync/records?${qs}`, token, fetchImpl);
}

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