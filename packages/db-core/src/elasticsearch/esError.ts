/**
 * ES 错误 body → 结构化信息（P8 S1）。
 *
 * 支持：
 *  - `{ error: { type, reason, root_cause: [{ type, reason, index }] } }`（ES 标准形态）；
 *  - `{ error: "..." }`（网关/反代的纯文本错误）；
 *  - `caused_by` 链（最多并入 3 层到 reason，便于 UI 一行展示根因）。
 *
 * 纯函数、零依赖；不打印原始 body（避免把凭据/文档内容带进日志）。
 */
export interface EsErrorCause {
  type?: string;
  reason?: string;
  index?: string;
}

export interface EsErrorInfo {
  type?: string;
  reason?: string;
  rootCause: EsErrorCause[];
}

function causeOf(v: unknown): EsErrorCause | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: EsErrorCause = {};
  if (typeof o.type === 'string') out.type = o.type;
  if (typeof o.reason === 'string') out.reason = o.reason;
  if (typeof o.index === 'string') out.index = o.index;
  return out.type !== undefined || out.reason !== undefined || out.index !== undefined ? out : undefined;
}

export function parseEsError(body: unknown): EsErrorInfo | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const err = (body as Record<string, unknown>).error;
  if (err === undefined) return undefined;
  if (typeof err === 'string') return { reason: err, rootCause: [] };
  if (typeof err !== 'object' || err === null) return undefined;
  const o = err as Record<string, unknown>;
  const root = Array.isArray(o.root_cause)
    ? o.root_cause.map(causeOf).filter((c): c is EsErrorCause => !!c)
    : [];
  const info: EsErrorInfo = { rootCause: root };
  if (typeof o.type === 'string') info.type = o.type;
  if (typeof o.reason === 'string') info.reason = o.reason;
  if (info.reason === undefined) {
    let cur: unknown = o.caused_by;
    const chain: string[] = [];
    for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
      const c = cur as Record<string, unknown>;
      if (typeof c.reason === 'string') chain.push(c.reason);
      cur = c.caused_by;
    }
    if (chain.length) info.reason = chain.join(' ← ');
  }
  return info;
}