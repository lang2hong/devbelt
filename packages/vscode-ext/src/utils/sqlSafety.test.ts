import { describe, expect, it } from 'vitest';
import { analyzeSqlRisk } from './sqlRisk';

describe('analyzeSqlRisk', () => {
  it('allows read-only statements', () => {
    expect(analyzeSqlRisk('SELECT * FROM users')).toEqual({ level: 'none', isWrite: false });
  });

  it('marks an UPDATE without WHERE as critical', () => {
    expect(analyzeSqlRisk('UPDATE users SET enabled = 0')).toMatchObject({
      level: 'critical',
      isWrite: true,
      reason: 'UPDATE or DELETE without WHERE',
    });
  });

  it('marks DDL as critical after stripping comments', () => {
    expect(analyzeSqlRisk('-- cleanup\nDROP TABLE users')).toMatchObject({
      level: 'critical',
      reason: 'DDL or permission change',
    });
  });

  it('detects writes anywhere in an imported SQL script', () => {
    expect(analyzeSqlRisk('SELECT * FROM users; INSERT INTO audit_log VALUES (1)')).toMatchObject({
      level: 'write',
      isWrite: true,
    });
  });
});
