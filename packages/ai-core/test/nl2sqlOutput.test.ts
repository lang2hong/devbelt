import { describe, expect, it } from 'vitest';
import { parseSqlAnswer } from '../src/nl2sqlOutput.js';

describe('parseSqlAnswer（§6.7.1 C 输出契约，宽松解析）', () => {
  it('标准布局：复述 + sql 块 + Assumptions bullets', () => {
    const text = [
      '**意图理解：**统计每个用户已完成订单的实付总额，按金额倒序。',
      '',
      '```sql',
      'SELECT user_id, SUM(total) AS gmv FROM orders WHERE status = \'done\' GROUP BY user_id ORDER BY gmv DESC;',
      '```',
      '',
      'Assumptions:',
      '- 把"总额"映射为 orders.total（分）',
      '- 只统计 status=done 的订单',
    ].join('\n');
    const parsed = parseSqlAnswer(text);
    expect(parsed.sql).toContain('SELECT user_id, SUM(total)');
    expect(parsed.intentParaphrase).toBe('统计每个用户已完成订单的实付总额，按金额倒序。');
    expect(parsed.assumptions).toEqual(['把"总额"映射为 orders.total（分）', '只统计 status=done 的订单']);
  });

  it('复述在代码块之后也能解析；Assumptions 在代码块前也能解析', () => {
    const text = [
      'Assumptions: none',
      '```sql',
      'SELECT 1;',
      '```',
      '意图理解: 只做连通性验证',
    ].join('\n');
    const parsed = parseSqlAnswer(text);
    expect(parsed.sql).toBe('SELECT 1;');
    expect(parsed.intentParaphrase).toBe('只做连通性验证');
    expect(parsed.assumptions).toEqual([]);
  });

  it('缺复述/缺假设 → 空字段（不抛错）', () => {
    const parsed = parseSqlAnswer('```sql\nSELECT 2;\n```');
    expect(parsed.sql).toBe('SELECT 2;');
    expect(parsed.intentParaphrase).toBe('');
    expect(parsed.assumptions).toEqual([]);
  });

  it('无代码块 → sql 为空串', () => {
    const parsed = parseSqlAnswer('**意图理解：**无法生成 SQL，缺少订单表。\nAssumptions:\n- schema 中未找到 orders');
    expect(parsed.sql).toBe('');
    expect(parsed.intentParaphrase).toBe('无法生成 SQL，缺少订单表。');
    expect(parsed.assumptions).toEqual(['schema 中未找到 orders']);
  });

  it('多个代码块：优先 ```sql，其次首个无标注块', () => {
    expect(parseSqlAnswer('```json\n{}\n```\n```sql\nSELECT 3;\n```').sql).toBe('SELECT 3;');
    expect(parseSqlAnswer('```\nSELECT 4;\n```\n```sql\nSELECT 5;\n```').sql).toBe('SELECT 5;');
  });

  it('Assumptions 超过 3 条截断；none/无 视为空', () => {
    const many = ['Assumptions:', '- a', '- b', '- c', '- d'].join('\n');
    expect(parseSqlAnswer(many).assumptions).toEqual(['a', 'b', 'c']);
    expect(parseSqlAnswer('Assumptions: none').assumptions).toEqual([]);
    expect(parseSqlAnswer('假设：无').assumptions).toEqual([]);
  });

  it('Assumptions 后跟随其他标题时截断收集', () => {
    const text = ['Assumptions:', '- 假设一', '', '## 说明', '- 不是假设'].join('\n');
    expect(parseSqlAnswer(text).assumptions).toEqual(['假设一']);
  });

  it('行内形态：Assumptions: 假设1；假设2', () => {
    expect(parseSqlAnswer('Assumptions: 假设一；假设二').assumptions).toEqual(['假设一', '假设二']);
  });

  it('强调符被剥离（复述/假设）', () => {
    const parsed = parseSqlAnswer('**意图理解：**`统计` **每日** GMV\nAssumptions:\n- *口径*：按下单时间');
    expect(parsed.intentParaphrase).toBe('统计 每日 GMV');
    expect(parsed.assumptions).toEqual(['口径：按下单时间']);
  });
});