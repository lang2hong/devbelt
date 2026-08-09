export type SqlRiskLevel = 'none' | 'write' | 'critical';

export interface SqlRisk {
  level: SqlRiskLevel;
  isWrite: boolean;
  reason?: string;
}

/** A conservative, dependency-free classifier used by every execution surface. */
export function analyzeSqlRisk(sql: string): SqlRisk {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim()
    .toUpperCase();
  if (!normalized) return { level: 'none', isWrite: false };

  const isDdl = /\b(CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/.test(normalized);
  const isWrite = isDdl || /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(normalized);
  if (!isWrite) return { level: 'none', isWrite: false };
  if (isDdl) return { level: 'critical', isWrite: true, reason: 'DDL or permission change' };

  const updateOrDelete = /\b(UPDATE|DELETE)\b/.test(normalized);
  if (updateOrDelete && !/\bWHERE\b/.test(normalized)) {
    return { level: 'critical', isWrite: true, reason: 'UPDATE or DELETE without WHERE' };
  }
  return { level: 'write', isWrite: true };
}
