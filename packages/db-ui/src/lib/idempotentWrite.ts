import { newIdempotencyKey } from '../api/idempotency';

/**
 * 幂等写意图键生命周期（P3 §6.1 + F2）：每个业务意图（tag）首次提交铸一个键；
 * 可重试失败（网络/5xx 或 409 IDEMPOTENCY_IN_PROGRESS）保留该 tag 的键供重放；
 * 成功或不可重试的 4xx 终止后 reset(tag) 释放；下一次同 tag 业务动作铸新键。
 * 多 tag 并存，互不覆盖：同一页面可同时持有多个未终态写意图。
 */
export function useIdempotencyKey() {
  const keys = new Map<string, string>();

  function ensure(tag: string): string {
    let key = keys.get(tag);
    if (!key) {
      key = newIdempotencyKey();
      keys.set(tag, key);
    }
    return key;
  }

  function reset(tag: string): void {
    keys.delete(tag);
  }

  return { keys, ensure, reset };
}

/** 网络/5xx failure 与 409 IDEMPOTENCY_IN_PROGRESS 均可重试（保留原 key）；业务 4xx 为终止态。 */
export function isRetryableFailure(kind: string): boolean {
  return kind === 'failure' || kind === 'in-progress';
}