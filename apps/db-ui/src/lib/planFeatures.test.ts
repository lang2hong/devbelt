import { describe, expect, it } from 'vitest';
import { featureLabel, formatFeature, formatPrice, type FeatureDto } from './planFeatures';

function f(key: string, type: FeatureDto['type'], value: FeatureDto['value']): FeatureDto {
  return { key, type, value };
}

describe('featureLabel', () => {
  it('maps known keys and falls back to the raw key', () => {
    expect(featureLabel('allowedDatabaseTypes')).toBe('支持的数据库');
    expect(featureLabel('maxElasticNodes')).toBe('maxElasticNodes');
  });
});

describe('formatFeature', () => {
  it('formats booleans as 支持/不支持', () => {
    expect(formatFeature(f('allowConnectionImport', 'bool', true))).toBe('支持');
    expect(formatFeature(f('allowConnectionImport', 'bool', false))).toBe('不支持');
  });

  it('formats bytes as MiB, treating 0 as unlimited', () => {
    expect(formatFeature(f('syncStorageBytes', 'bytes', 268435456))).toBe('256 MiB');
    expect(formatFeature(f('syncStorageBytes', 'bytes', 33554432))).toBe('32 MiB');
    expect(formatFeature(f('syncStorageBytes', 'bytes', 0))).toBe('不限');
  });

  it('formats numbers, treating 0 as unlimited', () => {
    expect(formatFeature(f('maxSavedConnections', 'number', 10))).toBe('10');
    expect(formatFeature(f('maxDevices', 'number', 0))).toBe('不限');
  });

  it('labels known engines and flags unknown ones as 即将支持', () => {
    expect(formatFeature(f('allowedDatabaseTypes', 'stringList', ['mysql', 'postgresql', 'sqlite']))).toBe('MySQL、PostgreSQL、SQLite');
    expect(formatFeature(f('allowedDatabaseTypes', 'stringList', ['mysql', 'redis', 'elasticsearch']))).toBe('MySQL、redis（即将支持）、elasticsearch（即将支持）');
  });

  it('joins non-engine string lists verbatim', () => {
    expect(formatFeature(f('someOtherList', 'stringList', ['a', 'b']))).toBe('a、b');
  });
});

describe('formatPrice', () => {
  it('renders personal free and paid prices', () => {
    expect(formatPrice({ unit: 'month', priceCents: 0 })).toBe('免费');
    expect(formatPrice({ unit: 'month', priceCents: 9900 })).toBe('¥99 / 月');
  });

  it('renders seat-month prices and pending placeholder', () => {
    expect(formatPrice({ unit: 'seat-month', priceCents: 0 })).toBe('待定价');
    expect(formatPrice({ unit: 'seat-month', priceCents: 5000 })).toBe('¥50 / 席·月');
  });
});