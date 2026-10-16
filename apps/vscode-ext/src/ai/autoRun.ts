import { classifyAiSql } from '@devbelt/ai-core';
import { sqlSkeleton, type SqlScanOptions } from '@devbelt/db-core/sql';

/**
 * AI 回复 SQL 自动执行判定（P9 §6.7.1E 红线受控例外，2026-10-15）：
 * **仅无风险只读语句自动执行**；写/DDL（UPDATE/INSERT/DELETE/ALTER/CREATE/DROP/
 * TRUNCATE…）一律不自动——保留手动「Run in chat」按钮，由人工过目后再执行。
 *
 * 双重门禁：
 * ① 语句形态白名单——骨架化后逐语句必须以只读关键字起始。风险分类器只做
 *    「未命中写关键字」判定，BEGIN/COMMIT/ROLLBACK/SET/USE/KILL/FLUSH/LOCK 等
 *    控制语句都会落到 `label='read'`；共享会话上自动执行它们会波及他人
 *    （如 ROLLBACK 回滚未提交事务、KILL 掐连接），因此不能以分类标签为唯一依据；
 * ② 风险分类复用 ai-core `classifyAiSql`（与执行门禁 confirmSqlExecution 同一
 *    分类器，不维护独立 denylist）；真正的拦截仍在执行层（行数上限/确认/只读/
 *    生产门禁）。
 */
/** 模板占位符（`<tenant_id>` 尖括号标识、`...` 省略、`{{x}}`）——绝不自动执行。 */
const PLACEHOLDER_PATTERN = /<[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*>|\.\.\.|\{\{[^}]*\}\}/;

/** 只读语句起始关键字（逐语句校验；`WITH` 夹带 DML 由风险分类器拦截）。 */
const READ_START_PATTERN = /^(SELECT|WITH|SHOW|DESC|DESCRIBE|EXPLAIN)\b/i;

export function isAutoExecutableSql(sql: string, options?: SqlScanOptions): boolean {
  const text = sql.trim();
  if (!text) return false;
  // AI 在缺 schema 时可能吐「待替换占位符」模板：自动执行只会得到语法错，
  // 绝不跑；手动按钮保留（人工可改后执行）。
  if (PLACEHOLDER_PATTERN.test(text)) return false;
  // 形态白名单：sqlSkeleton 挖空字符串/普通注释，避免字面量里的分号被误拆。
  const statements = sqlSkeleton(text, options)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0 || !statements.every((s) => READ_START_PATTERN.test(s))) return false;
  const cls = classifyAiSql(text, options);
  return cls.label === 'read' && !cls.isWrite;
}