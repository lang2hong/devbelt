import type { AuditEvent } from '../domain/entities.js';

/** 审计事件 → API DTO（§6：id 转十进制 string、时间 ISO）。 */
export function auditDto(e: AuditEvent) {
  return {
    eventId: String(e.id),
    eventTime: e.eventTime.toISOString(),
    actorUserId: e.actorUserId != null ? String(e.actorUserId) : null,
    actorRole: e.actorRole,
    eventType: e.eventType,
    targetType: e.targetType,
    targetId: e.targetId,
    organizationId: e.organizationId != null ? String(e.organizationId) : null,
    sourceIp: e.sourceIp,
    requestId: e.requestId,
    result: e.result,
    failureCode: e.failureCode,
    reason: e.reason,
  };
}

/** DTO 行 → CSV。含公式注入防护（§6 导出边界）。 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    if (v == null) return '';
    let s = String(v);
    // 公式注入：剥离前导空白后若以 = + - @ 或制表/回车开头，对原始值统一前缀单引号，
    // 阻断 Excel/Sheets 把单元格当公式执行（含 `  =HYPERLINK(...)` 型带前导空白的绕过）。
    if (/^[=+\-@\t\r]/.test(s.replace(/^\s+/, ''))) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))];
  return lines.join('\n');
}