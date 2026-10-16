import { describe, expect, it } from 'vitest';
import { formatModelLines, parseModelLines } from './providerModels';

describe('parseModelLines / formatModelLines', () => {
  it('解析默认标记、显示名、空行；可往返', () => {
    const r = parseModelLines('*gpt-4o-mini | GPT-4o mini\n\n gpt-4o \nfoo|bar|baz');
    expect(r.error).toBeUndefined();
    expect(r.models).toEqual([
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', default: true },
      { id: 'gpt-4o' },
      { id: 'foo', label: 'bar|baz' },
    ]);
    expect(parseModelLines(formatModelLines(r.models)).models).toEqual(r.models);
  });

  it('非法输入给出错误：空/含空白/重复/多个默认/超量', () => {
    expect(parseModelLines('').error).toBeTruthy();
    expect(parseModelLines('a b').error).toBeTruthy();
    expect(parseModelLines('a\na').error).toBeTruthy();
    expect(parseModelLines('*a\n*b').error).toBeTruthy();
    expect(parseModelLines('*').error).toBeTruthy();
    expect(parseModelLines(Array.from({ length: 51 }, (_, i) => `m${i}`).join('\n')).error).toBeTruthy();
  });
});
