import { getAccessToken } from './tokenStore';
import { authedFetch, type FetchLike } from './authedFetch';

/**
 * 本人设备 API 客户端（P3 §5.2）。撤销为 console 写请求，幂等键由调用方铸定；
 * 撤销当前 Web Console 设备时服务端返回 CURRENT_SESSION_REVOKED，前端据此登出。
 * 全部走 authedFetch：会话中 401 静默刷新后重放一次。
 */

export interface Device {
  deviceId: string;
  devicePlatform: string;
  deviceName: string;
  clientVersion: string | null;
  status: string;
  lastUsedTime: string | null;
  createTime: string;
}

export type ListDevicesResult =
  | { kind: 'ok'; devices: Device[] }
  | { kind: 'unauthorized' }
  | { kind: 'failure' };

export type RevokeDeviceResult =
  | { kind: 'ok'; currentSessionRevoked: boolean }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' }
  | { kind: 'failure' };

function auth(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

export async function listDevices(
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<ListDevicesResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch('/api/personal/devices', { headers: auth(token) }, fetchImpl);
    if (res.ok) return { kind: 'ok', devices: (await res.json()).devices };
    if (res.status === 401) return { kind: 'unauthorized' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}

export async function revokeDevice(
  deviceId: string,
  idempotencyKey: string,
  csrfToken: string,
  token: string | null = getAccessToken(),
  fetchImpl: FetchLike = fetch,
): Promise<RevokeDeviceResult> {
  if (!token) return { kind: 'unauthorized' };
  try {
    const res = await authedFetch(
      `/api/personal/devices/${deviceId}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': idempotencyKey,
        },
      },
      fetchImpl,
    );
    if (res.ok) {
      const body = await res.json();
      return { kind: 'ok', currentSessionRevoked: body.code === 'CURRENT_SESSION_REVOKED' };
    }
    if (res.status === 401) return { kind: 'unauthorized' };
    if (res.status === 404) return { kind: 'not-found' };
    return { kind: 'failure' };
  } catch {
    return { kind: 'failure' };
  }
}