/**
 * 共享错误分派（P3 切片 4 统一口径）。
 * 把 response 状态码（+ 409 幂等 code）映射为 Result 判别并；409 内仅
 * `IDEMPOTENCY_IN_PROGRESS` 为可重试，其余（含 `IDEMPOTENCY_KEY_REUSED`）为 conflict 终态。
 */
export type FailureKind = 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'in-progress' | 'failure';

export async function resolveErrorKind(res: Response): Promise<FailureKind> {
  if (res.status === 401) return 'unauthorized';
  if (res.status === 403) return 'forbidden';
  if (res.status === 404) return 'not-found';
  if (res.status === 409) {
    try {
      const body = (await res.json()) as { code?: string; error?: { code?: string } };
      // 兼容两类信封：console/public API 的 `{ error: { code } }` 与共享 API 的平铺 `{ code }`。
      const code = body?.error?.code ?? body?.code;
      if (code === 'IDEMPOTENCY_IN_PROGRESS') return 'in-progress';
    } catch {
      // 非 JSON 409 视作业务冲突
    }
    return 'conflict';
  }
  return 'failure';
}