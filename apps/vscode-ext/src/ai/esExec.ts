import { parseEsError, parseSearchResponse } from '@devbelt/db-core';
import type { ElasticsearchConnectionSession } from '../connection/connectionSession.js';
import { l10n } from '../i18n';

/**
 * AI 生成的 ES DSL 执行桥（P9 S7c）。
 *
 * 红线与 ES 面板 DSL tab 同构：
 *  - **用户点击才执行**（AI 永不自动执行）；
 *  - 请求固定为 `POST /<index>/_search`（只读路径，`EsClient` 白名单放行；只读连接不受影响）；
 *  - 生成物只允许查询 DSL——执行层不接受索引名/路径/方法（契约层已禁止，这里是最终屏障）。
 * 结果摘要回帖（total/took/前 3 条 _source 截断 + aggregations 存在性）。
 */
const HIT_PREVIEW = 3;
const PREVIEW_CHARS = 600;
const DEFAULT_SIZE = 20;

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
    return { title, content: l10n('ai.es.invalidJson', { error: (err as Error).message }), isError: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { title, content: l10n('ai.es.invalidJson', { error: 'not an object' }), isError: true };
  }
  const body = { ...(parsed as Record<string, unknown>) };
  if (body.size === undefined) body.size = DEFAULT_SIZE;

  try {
    const res = await session.es.request('POST', `/${encodeURIComponent(index)}/_search`, body);
    if (res.status >= 400) {
      const info = parseEsError(res.body);
      const reason = info?.reason ?? info?.type ?? 'unknown error';
      return { title, content: l10n('ai.es.httpError', { status: res.status, reason }), isError: true };
    }
    const summary = parseSearchResponse(res.body);
    const lines = [
      l10n('ai.es.summary', {
        total: summary.total ?? '?',
        took: summary.took ?? '?',
      }),
    ];
    if (summary.timedOut) lines.push(l10n('ai.es.timedOut'));
    for (const hit of summary.hits.slice(0, HIT_PREVIEW)) {
      lines.push(`_id=${hit.id}: ${truncate(JSON.stringify(hit.source))}`);
    }
    if (summary.aggregations) lines.push(l10n('ai.es.aggregations'));
    return { title, content: lines.join('\n'), isError: false };
  } catch (err) {
    return { title, content: l10n('ai.es.httpError', { status: 0, reason: (err as Error).message }), isError: true };
  }
}

function truncate(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}