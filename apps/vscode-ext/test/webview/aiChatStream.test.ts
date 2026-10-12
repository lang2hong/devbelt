import { describe, expect, it } from 'vitest';
import { parseInlineSegments, parseMessageBlocks } from '../../webview/src/utils/aiChatStream';

describe('parseMessageBlocks（围栏代码块 + 文本）', () => {
  it('纯文本：单个文本块，首尾空行裁剪', () => {
    expect(parseMessageBlocks('\nhello\nworld\n')).toEqual([{ type: 'text', content: 'hello\nworld' }]);
  });

  it('文本 + sql 代码块 + 文本', () => {
    const text = '看这条 SQL：\n```sql\nSELECT 1;\n```\n它会返回一行。';
    expect(parseMessageBlocks(text)).toEqual([
      { type: 'text', content: '看这条 SQL：' },
      { type: 'code', lang: 'sql', content: 'SELECT 1;' },
      { type: 'text', content: '它会返回一行。' },
    ]);
  });

  it('无语言标识的围栏（``` 单独一行）', () => {
    expect(parseMessageBlocks('```\nplain\n```')).toEqual([{ type: 'code', lang: '', content: 'plain' }]);
  });

  it('多个代码块', () => {
    const blocks = parseMessageBlocks('a\n```sql\nS1\n```\nb\n```json\n{"a":1}\n```');
    const codeBlocks = blocks.filter((b) => b.type === 'code');
    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[1]).toEqual({ type: 'code', lang: 'json', content: '{"a":1}' });
  });

  it('未闭合围栏（流式进行中）按代码块渲染，不吞掉后半段', () => {
    expect(parseMessageBlocks('```sql\nSELECT *')).toEqual([{ type: 'code', lang: 'sql', content: 'SELECT *' }]);
  });

  it('空消息 → 空数组', () => {
    expect(parseMessageBlocks('')).toEqual([]);
    expect(parseMessageBlocks('   \n  ')).toEqual([]);
  });

  it('代码块内反引号行不误判闭合（仅整行 ``` 才闭合）', () => {
    const blocks = parseMessageBlocks('```\na `b` c\n```');
    expect(blocks).toEqual([{ type: 'code', lang: '', content: 'a `b` c' }]);
  });
});

describe('parseInlineSegments（行内 code）', () => {
  it('无行内 code → 单个文本段', () => {
    expect(parseInlineSegments('普通文本')).toEqual([{ type: 'text', content: '普通文本' }]);
  });

  it('混合行内 code', () => {
    expect(parseInlineSegments('执行 `SELECT 1` 然后看 `orders` 表')).toEqual([
      { type: 'text', content: '执行 ' },
      { type: 'code', content: 'SELECT 1' },
      { type: 'text', content: ' 然后看 ' },
      { type: 'code', content: 'orders' },
      { type: 'text', content: ' 表' },
    ]);
  });

  it('跨行不匹配（`a\\nb` 不算行内 code）', () => {
    expect(parseInlineSegments('`a\nb`')).toEqual([{ type: 'text', content: '`a\nb`' }]);
  });
});