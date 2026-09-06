import type { SyncRunResult } from './e2e/syncEngine';

/**
 * 状态栏可观测状态的纯派生（零 vscode 依赖，便于单测）。
 *
 * 派生规则（优先级从高到低）：
 *  - 未解锁 → hidden（隐藏状态栏，禁用 syncNow）。
 *  - stalled（conflict/terminal/epoch-mismatch/paging-stalled）→ stalled。
 *  - 失败（lastError 或 lastRun.stage==='error'）：
 *      - 正在退避重试 → retrying；
 *      - 否则 → error。
 *  - 其余 → idle。
 *
 * 关键约束：`stage:'error'` 绝不可落到 idle（否则同步失败被误报为“已是最新”）。
 */
export type SyncStatusKind = 'hidden' | 'idle' | 'error' | 'retrying' | 'stalled';

export interface SyncStatusInput {
  isUnlocked: boolean;
  stalled: boolean;
  retrying: boolean;
  lastError?: string;
  lastRun?: SyncRunResult;
}

export function deriveSyncStatus(input: SyncStatusInput): SyncStatusKind {
  if (!input.isUnlocked) return 'hidden';
  if (input.stalled) return 'stalled';
  const failed = input.lastError !== undefined || input.lastRun?.stage === 'error';
  if (failed) {
    return input.retrying ? 'retrying' : 'error';
  }
  return 'idle';
}