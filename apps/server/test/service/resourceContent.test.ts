import { describe, it, expect } from 'vitest';
import { canonicalJson, canonicalJsonBytes, validateResourceContent } from '../../src/modules/organization/service/resourceContent.js';
import { ResourceContentInvalidError } from '../../src/domain/errors.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and serializes compactly', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('bytes equal UTF-8 length of canonical form', () => {
    const v = { name: 'x', content: '中文' };
    expect(canonicalJsonBytes(v)).toBe(Buffer.byteLength(canonicalJson(v), 'utf8'));
  });
});

describe('validateResourceContent', () => {
  it('accepts a valid query', () => {
    expect(() => validateResourceContent('query', { sql: 'select 1' })).not.toThrow();
    expect(() => validateResourceContent('query', { sql: 'select 1', dialect: 'mysql' })).not.toThrow();
  });

  it('rejects blank sql and unknown query fields', () => {
    expect(() => validateResourceContent('query', { sql: '   ' })).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('query', { sql: 'select 1', password: 'x' })).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('query', { sql: 'select 1', dialect: 'oracle' })).toThrow(ResourceContentInvalidError);
  });

  it('accepts a valid connection_template', () => {
    expect(() => validateResourceContent('connection_template', {
      databaseType: 'mysql', host: 'localhost', port: 3306, database: 'db',
    })).not.toThrow();
  });

  it('rejects secret / path / key fields anywhere', () => {
    expect(() => validateResourceContent('connection_template', {
      databaseType: 'mysql', host: 'h', port: 3306, database: 'db', password: 'p',
    })).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('query', { sql: 'select 1', secretKey: 'x' })).toThrow(ResourceContentInvalidError);
  });

  it('rejects bad connection_template structure', () => {
    const base = { databaseType: 'mysql', host: 'h', port: 3306, database: 'db' };
    expect(() => validateResourceContent('connection_template', { ...base, extra: 1 })).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('connection_template', { ...base, host: '' })).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('connection_template', { ...base, port: 70000 })).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('connection_template', { ...base, ssl: { mode: 'nope' } })).toThrow(ResourceContentInvalidError);
  });

  it('rejects non-object content', () => {
    expect(() => validateResourceContent('query', 'select 1')).toThrow(ResourceContentInvalidError);
    expect(() => validateResourceContent('query', null)).toThrow(ResourceContentInvalidError);
  });
});