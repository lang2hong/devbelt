import { describe, expect, it } from 'vitest';
import {
  KEEP_RECENT, buildSummaryMessages, compressMessages, fitBudget, planHistory,
  sanitizeSummary, summaryBlock,
} from '../../src/ai/historyCompression';

const msg = (role: 'user' | 'assistant', content: string) => ({ role, content });

function conversation(n: number) {
  return Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `m${i} ${'x'.repeat(20)}`));
}

describe('history compression', () => {
  it('keeps the last 8 messages verbatim and summarizes the rest', () => {
    const plan = planHistory(conversation(20));
    expect(plan.recent).toHaveLength(KEEP_RECENT);
    expect(plan.recent[0]!.content).toContain('m12');
    expect(plan.pending).toHaveLength(12);
    expect(plan.fallback).toContain('m0');
  });

  it('does not call the model for a handful of new messages, and keeps them verbatim', () => {
    const small = planHistory(conversation(10));
    expect(small.pending).toHaveLength(0); // 只有 2 条更早
    expect(small.recent).toHaveLength(10); // 还没摘要，但也不能丢
    expect(planHistory(conversation(12)).pending).toHaveLength(4); // 攒够 4 条
  });

  it('only summarizes the increment after a previous summary', () => {
    const plan = planHistory(conversation(20), { covered: 8 });
    expect(plan.pending).toHaveLength(4);
    expect(plan.covered).toBe(8);
    expect(plan.boundary).toBe(12);
  });

  it('falls back to a compact transcript with code blocks squeezed', () => {
    const text = compressMessages([
      msg('user', '监控 lc_batch 每分钟新增'),
      msg('assistant', '好的\n```sql\nSELECT COUNT(*) FROM lc_batch\nWHERE received_time > 1\n```\n结束'),
    ]);
    expect(text).toContain('U: 监控 lc_batch');
    expect(text).toContain('[code: SELECT COUNT(*) FROM lc_batch]');
    expect(text).not.toContain('WHERE received_time');
  });

  it('keeps the head and drops the middle when the fallback exceeds its budget', () => {
    const text = compressMessages(conversation(60), 300);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('m0');
    expect(text).toContain('…');
  });

  it('drops the oldest recent messages only when over the char budget', () => {
    const messages = [msg('user', 'a'.repeat(50)), msg('assistant', 'b'.repeat(50)), msg('user', 'c'.repeat(50))];
    expect(fitBudget(messages, 1000).dropped).toBe(0);
    const fitted = fitBudget(messages, 100);
    expect(fitted.messages).toHaveLength(2);
    expect(fitted.dropped).toBe(1);
    expect(fitted.messages[0]!.content).toContain('b');
  });

  it('builds a rolling summary prompt and caps the output', () => {
    const messages = buildSummaryMessages('old summary', [msg('user', '监控 lc_batch')]);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.content).toContain('old summary');
    expect(messages[1]!.content).toContain('监控 lc_batch');
    expect(sanitizeSummary('  a\n\n\n\nb  ')).toBe('a\n\nb');
    expect(sanitizeSummary('x'.repeat(20), 10)).toHaveLength(10);
    expect(summaryBlock('  ')).toBeUndefined();
    expect(summaryBlock('要点')).toContain('要点');
  });
});