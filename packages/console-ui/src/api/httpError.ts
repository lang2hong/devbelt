/**
 * 共享错误分派（P3 切片 4 统一口径）。
 * 把 response 状态码（+ 409 幂等 code）映射为 Result 判别并；409 内仅
 * `IDEMPOTENCY_IN_PROGRESS` 为可重试，其余（含 `IDEMPOTENCY_KEY_REUSED`）为 conflict 终态。
 *
 * 400/422 是**客户端输入错误终态**（`bad-request`）——不可重试：修正输入后必须铸新
 * 幂等键再提交，否则服务端按同键不同请求体返回 IDEMPOTENCY_KEY_REUSED(409)，写操作
 * 陷入无法自行恢复的错误态。仅网络异常、5xx、429 与 IDEMPOTENCY_IN_PROGRESS 保留原键。
 */
export type FailureKind = 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'in-progress' | 'bad-request' | 'failure';

export async function resolveErrorKind(res: Response): Promise<FailureKind> {
  if (res.status === 401) return 'unauthorized';
  if (res.status === 403) return 'forbidden';
  if (res.status === 404) return 'not-found';
  if (res.status === 400 || res.status === 422) return 'bad-request';
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