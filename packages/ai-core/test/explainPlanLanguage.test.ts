import { describe, expect, it } from 'vitest';
import { buildExplainPlanMessages } from '../src/prompts/explainPlan.js';

const input = { statements: [{ sql: 'SELECT * FROM t', planText: 'Seq Scan' }], dbType: 'PG' };

describe('buildExplainPlanMessages language', () => {
  it('forces Simplified Chinese when asked', () => {
    const messages = buildExplainPlanMessages({ ...input, language: 'zh' });
    const user = messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Think through the plan');
    expect(user).toContain('visible reasoning in Simplified Chinese');
  });

  it('leaves the prompt unchanged without a language hint', () => {
    const user = buildExplainPlanMessages(input).find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('Simplified Chinese');
  });
});
