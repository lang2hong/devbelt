import { describe, expect, it } from 'vitest';
import { commandLines, extractRedisBlock, parseRedisAnswer } from '../src/redisOutput.js';
import { REDIS_SYSTEM_PROMPT } from '../src/prompts/redis.js';

describe('parseRedisAnswer（NL→Redis 输出契约）', () => {
  it('提取 redis 块：过滤空行/注释/SELECT；复述与假设同契约解析', () => {
    const text = [
      '**意图理解：**统计 user: 前缀的键数量。',
      '',
      '```redis',
      '# 注释行',
      'SCAN 0 MATCH user:* COUNT 100',
      '',
      'SELECT 2',
      'GET user:1',
      '```',
      '',
      'Assumptions:',
      '- 仅在当前选中逻辑库内统计',
    ].join('\n');
    const parsed = parseRedisAnswer(text);
    expect(parsed.commands).toEqual(['SCAN 0 MATCH user:* COUNT 100', 'GET user:1']);
    expect(parsed.block).toContain('SELECT 2');
    expect(parsed.intentParaphrase).toContain('user:');
    expect(parsed.assumptions).toEqual(['仅在当前选中逻辑库内统计']);
  });

  it('无 redis 标注 → 取首个无标注块；无块 → 空', () => {
    expect(extractRedisBlock('```\nPING\n```')).toBe('PING');
    expect(parseRedisAnswer('直接给答案，没有代码块').commands).toEqual([]);
    expect(parseRedisAnswer('```sql\nSELECT 1\n```').commands).toEqual([]);
  });

  it('commandLines：// 注释与 select（任意大小写）同样过滤', () => {
    expect(commandLines('// c\nselect 1\n  \nPING')).toEqual(['PING']);
  });

  it('REDIS_SYSTEM_PROMPT 含契约令牌与红线（SELECT/不编造 key）', () => {
    expect(REDIS_SYSTEM_PROMPT).toContain('```redis');
    expect(REDIS_SYSTEM_PROMPT).toContain('意图理解');
    expect(REDIS_SYSTEM_PROMPT).toMatch(/NEVER emit SELECT/);
    expect(REDIS_SYSTEM_PROMPT).toMatch(/never invent key names/);
  });
});
