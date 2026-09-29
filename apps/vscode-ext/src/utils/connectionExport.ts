import { ConnectionStore } from '@devbelt/db-host/connection/connectionStore';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { hasUrlCredentials, stripUrlCredentials } from './connectionUrl';

/**
 * 导出用「去密」：统一按 `ConnectionStore.SENSITIVE_FIELDS` 删除，避免新增敏感字段
 * （如 sentinelPassword）时漏删；URL 内嵌凭据一并剥离。
 */
export function sanitizeConnectionForExport(
  conn: SavedConnection,
): { out: Record<string, unknown>; urlStripped: boolean } {
  const out: Record<string, unknown> = { ...conn };
  for (const field of ConnectionStore.SENSITIVE_FIELDS) delete out[field];
  let urlStripped = false;
  if (typeof out.connectionUrl === 'string' && hasUrlCredentials(out.connectionUrl)) {
    out.connectionUrl = stripUrlCredentials(out.connectionUrl);
    urlStripped = true;
  }
  return { out, urlStripped };
}