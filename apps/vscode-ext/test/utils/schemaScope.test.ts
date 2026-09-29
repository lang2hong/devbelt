import { describe, expect, it, vi } from 'vitest';

const shown: string[] = [];
vi.mock('vscode', () => ({
  window: { showErrorMessage: (m: string) => { shown.push(m); } },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import { defaultPgSchema, isNonDefaultSchema, ensureSchemaWritable } from '../../src/utils/schemaScope';

const pg = (over: Record<string, unknown> = {}): any => ({ id: 'c', dbType: 'PG', host: 'h', port: 5432, ...over });
const mysql: any = { id: 'm', dbType: 'MYSQL', host: 'h', port: 3306 };

describe('schemaScope（B1a 写保护）', () => {
  it('默认 schema：未配置为 public；配置后为所配值', () => {
    expect(defaultPgSchema(pg())).toBe('public');
    expect(defaultPgSchema(pg({ schema: 'app' }))).toBe('app');
  });

  it('非默认 schema 判定：仅 PG 且与默认不同', () => {
    expect(isNonDefaultSchema(pg(), 'public')).toBe(false);
    expect(isNonDefaultSchema(pg(), 'other')).toBe(true);
    expect(isNonDefaultSchema(pg({ schema: 'app' }), 'app')).toBe(false);
    expect(isNonDefaultSchema(pg({ schema: 'app' }), 'other')).toBe(true);
    expect(isNonDefaultSchema(mysql, 'other')).toBe(false);
    expect(isNonDefaultSchema(pg(), undefined)).toBe(false);
  });

  it('ensureSchemaWritable：非默认 schema 提示并返回 false', () => {
    shown.length = 0;
    expect(ensureSchemaWritable(pg(), 'public')).toBe(true);
    expect(ensureSchemaWritable(pg(), 'other')).toBe(false);
    expect(shown).toHaveLength(1);
  });
});