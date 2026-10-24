import { describe, expect, it } from 'vitest';
import { isPiiColumn, maskValue, parseMaskingConfig } from '../src/index.js';

const ctx = { salt: 'salt-1', domain: 'users.email' };

describe('maskValue', () => {
  it('is deterministic for the same salt, domain and value', () => {
    const a = maskValue({ rule: 'email' }, 'a@x.test', ctx);
    const b = maskValue({ rule: 'email' }, 'a@x.test', ctx);
    expect(a).toBe(b);
    expect(a).toMatch(/^u[0-9a-f]{10}@masked\.invalid$/);
  });

  it('changes with salt or domain and keeps format per rule', () => {
    expect(maskValue({ rule: 'hash' }, 'x', ctx)).not.toBe(maskValue({ rule: 'hash' }, 'x', { ...ctx, salt: 'salt-2' }));
    expect(maskValue({ rule: 'hash' }, 'x', ctx)).not.toBe(maskValue({ rule: 'hash' }, 'x', { ...ctx, domain: 'other' }));
    expect(maskValue({ rule: 'phone' }, '13800000000', ctx)).toHaveLength(11);
    expect(maskValue({ rule: 'idCard' }, '110101199001011234', ctx)).toHaveLength(18);
    expect(maskValue({ rule: 'bankCard' }, '6222000000000000', ctx)).toContain('****');
  });

  it('supports redact, null, fixed, regex and hash', () => {
    expect(maskValue({ rule: 'redact' }, 'secret', ctx)).toBe('[REDACTED]');
    expect(maskValue({ rule: 'null' }, 'secret', ctx)).toBeNull();
    expect(maskValue({ rule: 'fixed', value: 'X' }, 'secret', ctx)).toBe('X');
    expect(maskValue({ rule: 'regex', pattern: '\\d', replacement: '*' }, 'a1b2', ctx)).toBe('a*b*');
    expect(maskValue({ rule: 'hash' }, 'v', ctx)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns null for null/undefined and truncates to maxLength', () => {
    expect(maskValue({ rule: 'email' }, null, ctx)).toBeNull();
    expect(maskValue({ rule: 'email' }, undefined, ctx)).toBeNull();
    expect(maskValue({ rule: 'idCard' }, 'x', { ...ctx, maxLength: 10 })).toHaveLength(10);
  });

  it('flags PII-looking columns without false positives for common words', () => {
    for (const name of ['email', 'user_phone', 'id_card', 'bankCard', 'password', 'full_name']) expect(isPiiColumn(name), name).toBe(true);
    for (const name of ['id', 'status', 'created_at', 'amount']) expect(isPiiColumn(name), name).toBe(false);
  });
});

describe('parseMaskingConfig', () => {
  it('accepts a valid config and shorthand rules', () => {
    const r = parseMaskingConfig({
      version: 1,
      tables: { users: { where: 'id > 0', columns: { email: 'email', phone: { rule: 'phone' }, note: { rule: 'fixed', value: 'x' } }, allowUnmasked: ['id'] } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.tables.users!.columns!.email).toEqual({ rule: 'email' });
    expect(r.config.tables.users!.allowUnmasked).toEqual(['id']);
  });

  it('rejects invalid versions, names, rules and regexes', () => {
    expect(parseMaskingConfig({ version: 2, tables: {} }).ok).toBe(false);
    expect(parseMaskingConfig({ version: 1, tables: { 'bad name': {} } }).ok).toBe(false);
    expect(parseMaskingConfig({ version: 1, tables: { t: { columns: { a: 'nope' } } } }).ok).toBe(false);
    expect(parseMaskingConfig({ version: 1, tables: { t: { columns: { a: { rule: 'fixed' } } } } }).ok).toBe(false);
    expect(parseMaskingConfig({ version: 1, tables: { t: { columns: { a: { rule: 'regex', pattern: '(', replacement: '' } } } } }).ok).toBe(false);
  });
});