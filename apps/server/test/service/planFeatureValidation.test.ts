import { describe, expect, it } from 'vitest';
import { validateFeatureValue } from '../../src/service/planFeatureValidation.js';
import { ValidationError } from '../../src/domain/errors.js';
import type { PlanFeatureDef } from '../../src/domain/entities.js';

function def(key: string, valueType: PlanFeatureDef['valueType']): PlanFeatureDef {
  return { id: 1, key, kind: 'personal', label: { en: key, zh: key }, valueType, unit: null, sortOrder: 0 };
}

describe('validateFeatureValue', () => {
  it('accepts well-formed values', () => {
    expect(() => validateFeatureValue(def('b', 'bool'), true)).not.toThrow();
    expect(() => validateFeatureValue(def('n', 'number'), 0)).not.toThrow();
    expect(() => validateFeatureValue(def('y', 'bytes'), 1048576)).not.toThrow();
    expect(() => validateFeatureValue(def('l', 'stringList'), ['mysql', 'sqlite'])).not.toThrow();
    expect(() => validateFeatureValue(def('e', 'enum'), 'mysql')).not.toThrow();
  });

  it('rejects string booleans and other wrong types', () => {
    expect(() => validateFeatureValue(def('b', 'bool'), 'false')).toThrow(ValidationError);
  });

  it('rejects NaN/negative/non-integer numbers (the 0=unlimited fail-open channel)', () => {
    for (const bad of [NaN, Infinity, -1, 1.5, '10']) {
      expect(() => validateFeatureValue(def('n', 'number'), bad)).toThrow(ValidationError);
    }
  });

  it('rejects non-array / non-string stringLists', () => {
    expect(() => validateFeatureValue(def('l', 'stringList'), 'mysql')).toThrow(ValidationError);
    expect(() => validateFeatureValue(def('l', 'stringList'), ['ok', 1])).toThrow(ValidationError);
    expect(() => validateFeatureValue(def('l', 'stringList'), [''])).toThrow(ValidationError);
  });

  it('rejects oversized values and unsafe integers', () => {
    expect(() => validateFeatureValue(def('n', 'number'), Number.MAX_SAFE_INTEGER + 1)).toThrow(ValidationError);
    expect(() => validateFeatureValue(def('l', 'stringList'), Array.from({ length: 65 }, () => 'x'))).toThrow(ValidationError);
    expect(() => validateFeatureValue(def('l', 'stringList'), ['x'.repeat(65)])).toThrow(ValidationError);
    expect(() => validateFeatureValue(def('e', 'enum'), 'x'.repeat(65))).toThrow(ValidationError);
  });
});