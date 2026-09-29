import { describe, expect, it } from 'vitest';
import { withDatabaseInUrl } from '../../src/utils/connectionUrl';

describe('withDatabaseInUrl（B2：PG 多库衍生会话改写 URL 库名）', () => {
  it('替换库名，保留 host/port/凭据', () => {
    expect(withDatabaseInUrl('postgres://u:p@h:5432/app', 'other')).toBe('postgres://u:p@h:5432/other');
  });

  it('保留 query（含 ?sslmode=）', () => {
    expect(withDatabaseInUrl('postgres://u:p@h:5432/app?sslmode=require', 'other'))
      .toBe('postgres://u:p@h:5432/other?sslmode=require');
  });

  it('无库名时补上', () => {
    expect(withDatabaseInUrl('postgres://u:p@h:5432', 'other')).toBe('postgres://u:p@h:5432/other');
  });

  it('库名做百分号编码', () => {
    expect(withDatabaseInUrl('postgres://u:p@h:5432/app', 'a b')).toBe('postgres://u:p@h:5432/a%20b');
  });
});