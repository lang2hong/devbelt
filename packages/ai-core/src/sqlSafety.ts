import {
  analyzeSqlRisk,
  classifyWriteKind,
  type SqlRiskLevel,
  type SqlScanOptions,
} from '@devbelt/db-core/sql';

export interface AiSqlClassification {
  kind: 'dml' | 'ddl' | 'other';
  level: SqlRiskLevel;
  isWrite: boolean;
  /** 代码块标签：read / write / critical。 */
  label: 'read' | 'write' | 'critical';
  reason?: string;
}

/**
 * AI 生成 SQL 的分类（UI 标签用）。
 *
 * 直接复用 `@devbelt/db-core/sql` 的 `classifyWriteKind` + `analyzeSqlRisk`
 * ——与执行门禁（confirmSqlExecution）共用同一分类器，AI 侧不维护独立 denylist，
 * 避免两套实现漂移。真正的拦截仍在执行层，这里只做展示标签。
 */
export function classifyAiSql(sql: string, options?: SqlScanOptions): AiSqlClassification {
  const kind = classifyWriteKind(sql, options);
  const risk = analyzeSqlRisk(sql, options);
  return {
    kind,
    level: risk.level,
    isWrite: risk.isWrite,
    label: risk.level === 'none' ? 'read' : risk.level,
    reason: risk.reason,
  };
}