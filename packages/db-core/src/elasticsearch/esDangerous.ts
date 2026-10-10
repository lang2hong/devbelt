/**
 * ES 危险操作判定（P8 S1，对齐 P7 的确认强度）。
 *
 * 命中清单（评审 D9）：
 *  - `DELETE /`、`DELETE /*`、`DELETE _all`（清库级删除）；
 *  - `DELETE <index>`（单一索引；要求输入索引名二次确认）；
 *  - `PUT/POST _cluster/settings`；
 *  - `POST <index>/_delete_by_query` 且 query 为 match_all（或未带 query）；
 *  - 非读方法触碰 `/_security/*`、`/_snapshot/*`、`/_template/*`。
 *
 * 纯函数；供 host 侧发送前弹确认，UI 判断失效也不会绕过（确认在 host）。
 */

export interface EsDangerousInfo {
  dangerous: boolean;
  /** 机器可读原因（UI 映射文案）。 */
  reason?: 'delete-all' | 'delete-index' | 'cluster-settings' | 'delete-by-query-match-all' | 'security-snapshot-template';
  /** `DELETE <index>`：要求用户输入该索引名确认（`*`/逗号多索引时缺省）。 */
  typedIndexName?: string;
}

/** 去掉 query，归一为以 `/` 开头的路径。 */
function normalizePath(path: string): string {
  const raw = String(path ?? '').split('?')[0].trim();
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function isMatchAll(body: unknown): boolean {
  if (!body || typeof body !== 'object') return true; // 未带 query：ES 对 _delete_by_query 视作 match_all
  const q = (body as Record<string, unknown>).query;
  if (!q || typeof q !== 'object') return true;
  return Object.prototype.hasOwnProperty.call(q, 'match_all');
}

export function isDangerousRequest(method: string, path: string, body?: unknown): EsDangerousInfo {
  const m = String(method ?? '').toUpperCase();
  const p = normalizePath(path);
  const segs = p.split('/').filter(Boolean);

  if (m === 'DELETE') {
    if (p === '/' || p === '/*' || p === '/_all') return { dangerous: true, reason: 'delete-all' };
    // 单层路径 = 索引级删除（`idx`、`idx*`、`idx1,idx2`）；`/idx/_doc/id` 等更深路径不是索引删除。
    if (segs.length === 1 && !segs[0].startsWith('_')) {
      const name = segs[0];
      return {
        dangerous: true,
        reason: 'delete-index',
        ...(name.includes(',') || name.includes('*') ? {} : { typedIndexName: name }),
      };
    }
  }

  if ((m === 'PUT' || m === 'POST') && p === '/_cluster/settings') {
    return { dangerous: true, reason: 'cluster-settings' };
  }

  if (m !== 'GET' && m !== 'HEAD'
    && (segs[0] === '_security' || segs[0] === '_snapshot' || segs[0] === '_template')) {
    return { dangerous: true, reason: 'security-snapshot-template' };
  }

  if (m === 'POST' && segs.length >= 2 && segs[segs.length - 1] === '_delete_by_query' && isMatchAll(body)) {
    return { dangerous: true, reason: 'delete-by-query-match-all' };
  }

  return { dangerous: false };
}