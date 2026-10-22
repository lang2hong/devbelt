import { describe, expect, it } from 'vitest';
import type { ExplainPlanNode, ExplainWarning } from '@devbelt/explain-core';
import { en, zh } from '../../src/i18n/catalog';
import {
  collectPlanIds,
  findPlanNode,
  flattenPlan,
  formatMs,
  formatNumber,
  WARNING_LABEL_KEYS,
  warningClass,
} from '../../webview/src/components/explain/types';

const leaf: ExplainPlanNode = {
  id: '2',
  operation: 'Index Scan',
  object: 'users',
  index: 'users_pkey',
  warnings: ['missingIndex'],
  children: [],
};
const root: ExplainPlanNode = {
  id: '1',
  operation: 'Nested Loop',
  warnings: ['nestedLoop'],
  children: [leaf],
};

describe('explain view helpers', () => {
  it('flattens only expanded branches', () => {
    expect(flattenPlan([root], new Set(['1'])).map((row) => [row.node.id, row.depth])).toEqual([
      ['1', 0],
      ['2', 1],
    ]);
    expect(flattenPlan([root], new Set()).map((row) => row.node.id)).toEqual(['1']);
  });

  it('collects and finds nodes deterministically', () => {
    expect(collectPlanIds([root])).toEqual(['1', '2']);
    expect(findPlanNode([root], '2')).toBe(leaf);
    expect(findPlanNode([root], 'missing')).toBeUndefined();
    expect(findPlanNode([root], null)).toBeUndefined();
  });

  it('has warning labels in both catalogs', () => {
    for (const warning of Object.keys(WARNING_LABEL_KEYS) as ExplainWarning[]) {
      const key = WARNING_LABEL_KEYS[warning];
      expect(en[key], key).toBeTruthy();
      expect(zh[key], key).toBeTruthy();
      expect(warningClass(warning)).toBe(`warn-${warning}`);
    }
  });

  it('formats metrics without NaN', () => {
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatMs(1.23456)).toBe('1.235 ms');
    expect(formatMs(undefined)).toBe('—');
  });
});