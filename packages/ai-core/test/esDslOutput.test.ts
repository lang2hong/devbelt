import { describe, expect, it } from 'vitest';
import { extractJsonBlock, parseEsDslAnswer } from '../src/esDslOutput.js';
import { ES_DSL_SYSTEM_PROMPT } from '../src/prompts/esDsl.js';

describe('parseEsDslAnswer（NL→ES DSL 输出契约）', () => {
  it('提取 json 块并解析请求体；复述与假设', () => {
    const text = [
      '**意图理解：**统计各状态订单数量。',
      '',
      '```json',
      '{ "size": 0, "aggs": { "by_status": { "terms": { "field": "status.keyword" } } } }',
      '```',
      '',
      'Assumptions:',
      '- status.keyword 存在',
    ].join('\n');
    const parsed = parseEsDslAnswer(text);
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.body).toMatchObject({ size: 0, aggs: { by_status: { terms: { field: 'status.keyword' } } } });
    expect(parsed.intentParaphrase).toContain('订单');
    expect(parsed.assumptions).toEqual(['status.keyword 存在']);
  });

  it('无标注块兜底；无块 → 空 bodyText', () => {
    expect(extractJsonBlock('```\n{"query":{"match_all":{}}}\n```')).toBe('{"query":{"match_all":{}}}');
    expect(parseEsDslAnswer('没有代码块').bodyText).toBe('');
  });

  it('非法 JSON / 数组 → parseError，不抛错', () => {
    expect(parseEsDslAnswer('```json\n{ bad }\n```').parseError).toBe('invalid-json');
    expect(parseEsDslAnswer('```json\n[1,2]\n```').parseError).toBe('not-an-object');
  });

  it('ES_DSL_SYSTEM_PROMPT 含契约令牌与红线', () => {
    expect(ES_DSL_SYSTEM_PROMPT).toContain('```json');
    expect(ES_DSL_SYSTEM_PROMPT).toContain('意图理解');
    expect(ES_DSL_SYSTEM_PROMPT).toMatch(/never emit the index name/);
    expect(ES_DSL_SYSTEM_PROMPT).toMatch(/_delete_by_query/);
  });
});
