import { parseEsError, parseSearchResponse } from '@devbelt/db-core';
import type { ElasticsearchConnectionSession } from '../connection/connectionSession.js';
import { l10n } from '../i18n';

/**
 * AI 生成的 ES DSL 执行桥（P9 S7c；回帖格式 S7i 改为按结果类型的 JSON）。
 *
 * 红线与 ES 面板 DSL tab 同构：
 *  - **用户点击才执行**（AI 永不自动执行）；
 *  - 请求固定为 `POST /<index>/_search`（只读路径，`EsClient` 白名单放行；只读连接不受影响）；
 *  - 生成物只允许查询 DSL——执行层不接受索引名/路径/方法（契约层已禁止，这里是最终屏障）。
 *
 * 回帖 JSON 适配：hits → `{index,took,total,hits[]}`；aggregations → `{index,took,total,aggregations}`；
 * suggest → `{index,took,suggest}`；其余 → 原始 body；错误 → `{status,type,reason,rootCause}`。
 */
const HIT_LIMIT = 20;
const DEFAULT_SIZE = 20;
/** 单条 `_source` 的字符串预算（防大文档撑爆回帖）。 */
const SOURCE_CHARS = 2000;
/** 成功结果整体序列化长度上限（超出截断，防超大聚合冻结 webview）。 */
const MAX_RESULT_CHARS = 20000;

export interface EsToolResult {
  title: string;
  content: string;
  isError: boolean;
}

export async function executeEsDsl(
  session: ElasticsearchConnectionSession,
  index: string,
  bodyText: string,
): Promise<EsToolResult> {
  const title = l10n('ai.es.title', { index });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return { title, content: errorJson(0, l10n('ai.es.invalidJson', { error: (err as Error).message })), isError: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { title, content: errorJson(0, l10n('ai.es.invalidJson', { error: 'not an object' })), isError: true };
  }
  const body = { ...(parsed as Record<string, unknown>) };
  if (body.size === undefined) body.size = DEFAULT_SIZE;
  else {
    const n = Number(body.size);
    if (!Number.isFinite(n) || n <= 0) body.size = DEFAULT_SIZE;
    else if (n > HIT_LIMIT) body.size = HIT_LIMIT;
  }

  try {
    const res = await session.es.request('POST', `/${encodeURIComponent(index)}/_search`, body);
    if (res.status >= 400) {
      const info = parseEsError(res.body);
      return { title, content: errorJson(res.status, info?.reason ?? info?.type ?? 'unknown error', info), isError: true };
    }
    const summary = parseSearchResponse(res.body);
    const raw = (res.body ?? {}) as Record<string, unknown>;
    const base = {
      index,
      took: summary.took,
      total: summary.total,
      ...(summary.timedOut ? { timedOut: true } : {}),
    };
    const rawHits = (raw.hits as { hits?: unknown[] } | undefined)?.hits;
    const hasAggregations = summary.aggregations && Object.keys(summary.aggregations as Record<string, unknown>).length > 0;
    let payload: Record<string, unknown>;
    if (hasAggregations) {
      payload = { ...base, aggregations: summary.aggregations };
    } else if (raw.suggest) {
      payload = { ...base, suggest: raw.suggest };
    } else if (Array.isArray(rawHits)) {
      payload = {
        ...base,
        hits: rawHits.slice(0, HIT_LIMIT).map((hit) => {
          const entry = (hit ?? {}) as Record<string, unknown>;
          return {
            ...(entry._id !== undefined ? { _id: entry._id } : {}),
            ...(entry._score !== undefined ? { _score: entry._score } : {}),
            ...(entry._source !== undefined ? { _source: truncateSource(entry._source) } : {}),
          };
        }),
      };
    } else {
      payload = { ...base, body: raw };
    }
    const json = JSON.stringify(payload, null, 2);
    return {
      title,
      content: json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : json,
      isError: false,
    };
  } catch (err) {
    return { title, content: errorJson(0, (err as Error).message), isError: true };
  }
}

/** 单条 `_source` 截断：把对象 JSON 化成字符串后按预算截断（回帖为文本展示，类型非敏感）。 */
function truncateSource(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (text.length <= SOURCE_CHARS) return value;
    return `${text.slice(0, SOURCE_CHARS)}… (truncated)`;
  } catch {
    return value;
  }
}

function errorJson(status: number, reason: string, info?: { type?: string; rootCause?: unknown }): string {
  return JSON.stringify(
    {
      status,
      ...(info?.type ? { type: info.type } : {}),
      reason,
      ...(info?.rootCause !== undefined ? { rootCause: info.rootCause } : {}),
    },
    null,
    2,
  );
}