import { describe, expect, it } from 'vitest';
import {
  reconcileColumnOrder,
  reconcileColumnWidths,
  reconcileHiddenColumns,
  reconcileLayout,
} from '../../src/result/tableLayout';

describe('reconcileHiddenColumns', () => {
  it('keeps only columns that still exist in the current fields', () => {
    expect(reconcileHiddenColumns(['id', 'old_col', 'name'], ['id', 'name', 'age'])).toEqual(['id', 'name']);
  });

  it('returns the saved list unchanged when known fields are empty', () => {
    expect(reconcileHiddenColumns(['id'], [])).toEqual(['id']);
  });
});

describe('reconcileColumnOrder', () => {
  it('preserves saved order and appends new fields that are not ordered', () => {
    expect(reconcileColumnOrder(['name', 'id', 'gone'], ['id', 'name', 'age'])).toEqual(['name', 'id', 'age']);
  });

  it('deduplicates and returns saved order when known fields are empty', () => {
    expect(reconcileColumnOrder(['name', 'name', 'id'], [])).toEqual(['name', 'name', 'id']);
  });
});

describe('reconcileColumnWidths', () => {
  it('keeps widths only for columns that still exist', () => {
    expect(reconcileColumnWidths({ id: 120, gone: 90 }, ['id', 'name'])).toEqual({ id: 120 });
  });

  it('returns saved widths unchanged when known fields are empty', () => {
    expect(reconcileColumnWidths({ id: 120 }, [])).toEqual({ id: 120 });
  });
});

describe('reconcileLayout', () => {
  it('reconciles all three layout dimensions together', () => {
    const saved = {
      hiddenColumns: ['id', 'gone'],
      columnOrder: ['name', 'id'],
      columnWidths: { id: 120, name: 80, gone: 90 },
    };
    expect(reconcileLayout(saved, ['id', 'name', 'age'])).toEqual({
      hiddenColumns: ['id'],
      columnOrder: ['name', 'id', 'age'],
      columnWidths: { id: 120, name: 80 },
    });
  });
});