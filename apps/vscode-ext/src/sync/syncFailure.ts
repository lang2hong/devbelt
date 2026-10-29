import { l10n } from '../i18n';

/**
 * 把同步失败的原因（引擎的 terminal 码 / 英文 reason）映射成用户可读、可操作的本地化文案。
 * 原始英文 reason 只进诊断日志，不直接展示给用户。
 */
export type SyncFailureKind =
  | 'quota'
  | 'signature'
  | 'featureRequired'
  | 'protocol'
  | 'auth'
  | 'epoch'
  | 'notInitialized'
  | 'network'
  | 'other';

export interface SyncFailureInput {
  stage?: string;
  terminalCode?: string;
  reason?: string;
}

const KIND_BY_CODE: Record<string, SyncFailureKind> = {
  SYNC_QUOTA_EXCEEDED: 'quota',
  SYNC_SIGNATURE_INVALID: 'signature',
  PERSONAL_FEATURE_REQUIRED: 'featureRequired',
  SYNC_PROTOCOL_UNSUPPORTED: 'protocol',
  SYNC_EPOCH_STALE: 'epoch',
  SYNC_NOT_INITIALIZED: 'notInitialized',
};

const MESSAGE_KEY: Record<SyncFailureKind, string> = {
  quota: 'sync.failure.quota',
  signature: 'sync.failure.signature',
  featureRequired: 'sync.failure.featureRequired',
  protocol: 'sync.failure.protocol',
  auth: 'sync.failure.auth',
  epoch: 'sync.statusEpochStale',
  notInitialized: 'sync.failure.notInitialized',
  network: 'sync.failure.network',
  other: 'sync.failure.other',
};

const NETWORK = /fetch failed|ECONN\w*|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|timed? ?out/i;

/** 文本（错误消息 / 错误码）是否像网络层故障。 */
export function looksLikeNetworkError(...parts: Array<string | undefined>): boolean {
  return NETWORK.test(parts.filter(Boolean).join(' '));
}

export function classifySyncFailure(input: SyncFailureInput): SyncFailureKind {
  const byCode = input.terminalCode ? KIND_BY_CODE[input.terminalCode] : undefined;
  if (byCode) return byCode;
  const reason = input.reason ?? '';
  if (input.stage === 'epoch-mismatch' || /epoch/i.test(reason)) return 'epoch';
  if (/authentication expired/i.test(reason)) return 'auth';
  if (/quota/i.test(reason)) return 'quota';
  if (/feed protocol unsupported/i.test(reason)) return 'protocol';
  if (NETWORK.test(reason)) return 'network';
  return 'other';
}

/** 本地化的失败说明；识别不了原因时给出指向诊断日志的通用文案。 */
export function describeSyncFailure(input: SyncFailureInput): string {
  return l10n(MESSAGE_KEY[classifySyncFailure(input)]);
}

/** 从一轮同步结果（或协调器抛出的 lastError）提取分类所需字段。 */
export function failureInputOf(
  result: { stage?: string; terminal?: { code?: string }; reason?: string } | undefined,
  lastError?: string,
): SyncFailureInput {
  return {
    stage: result?.stage,
    terminalCode: result?.terminal?.code,
    reason: result?.reason ?? lastError,
  };
}

/** 供诊断日志：错误名 + 状态/错误码 + 截断后的消息。不含口令等输入，调用方不要传敏感对象。 */
export function errorDetail(err: unknown, includeMessage = true): Record<string, unknown> {
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown } | null | undefined;
  const detail: Record<string, unknown> = {
    name: typeof e?.name === 'string' ? e.name : typeof err,
  };
  if (typeof e?.code === 'string') detail.code = e.code;
  if (typeof e?.status === 'number') detail.status = e.status;
  if (includeMessage) {
    const message = err instanceof Error ? err.message : String(err);
    detail.message = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  }
  return detail;
}
