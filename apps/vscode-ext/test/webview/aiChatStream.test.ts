import { describe, expect, it } from 'vitest';
import { autoExecutableSqlBlocks, AUTO_SQL_BLOCK_LIMIT, formatToolResultContent, isForeignSession, parseInlineSegments, parseMessageBlocks } from '../../webview/src/utils/aiChatStream';

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

describe('parseMessageBlocks（Markdown 表格）', () => {
  it('完整表格 → table 块（单元格去空白、\\| 还原、空单元格保留；单行标题合并为 summary）', () => {
    const text = '结果：\n| id | name |\n| --- | --- |\n| 1 | a\\|b |\n| 2 |  |\n完';
    expect(parseMessageBlocks(text)).toEqual([
      { type: 'table', summary: '结果：', header: ['id', 'name'], rows: [['1', 'a|b'], ['2', '']] },
      { type: 'text', content: '完' },
    ]);
  });

  it('无标题表格：summary 缺省；多行文本不与表格合并', () => {
    expect(parseMessageBlocks('| a |\n| --- |\n| 1 |')).toEqual([
      { type: 'table', header: ['a'], rows: [['1']] },
    ]);
    const blocks = parseMessageBlocks('第一行\n第二行\n| a |\n| --- |\n| 1 |');
    expect(blocks[0]).toEqual({ type: 'text', content: '第一行\n第二行' });
    expect(blocks[1]).toMatchObject({ type: 'table' });
    expect((blocks[1] as { summary?: string }).summary).toBeUndefined();
  });

  it('缺分隔行 → 不是表格（流式未闭合按文本）', () => {
    expect(parseMessageBlocks('| a | b |\n| c | d |')).toEqual([{ type: 'text', content: '| a | b |\n| c | d |' }]);
    expect(parseMessageBlocks('| a | b |')).toEqual([{ type: 'text', content: '| a | b |' }]);
  });

  it('非管道分隔行（纯横线/非管道）不误判为表格', () => {
    expect(parseMessageBlocks('| a | b |\n-----\n| 1 | 2 |')).toEqual([
      { type: 'text', content: '| a | b |\n-----\n| 1 | 2 |' },
    ]);
    expect(parseMessageBlocks('| a |\nx---x\n| 1 |')).toEqual([{ type: 'text', content: '| a |\nx---x\n| 1 |' }]);
  });

  it('代码块内的管道行不解析为表格', () => {
    const blocks = parseMessageBlocks('```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```');
    expect(blocks).toEqual([{ type: 'code', lang: '', content: '| a | b |\n| --- | --- |\n| 1 | 2 |' }]);
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

describe('autoExecutableSqlBlocks（SQL 自动执行提取，P9 受控例外）', () => {
  it('提取 sql 与无 lang 的代码块（带原始块下标，与 CodeBlock.isSql 同口径）', () => {
    const text = '说明\n```sql\nSELECT 1;\n```\n中间\n```\nSELECT 2;\n```\n```redis\nGET k\n```';
    expect(autoExecutableSqlBlocks(text)).toEqual([
      { blockIdx: 1, content: 'SELECT 1;' },
      { blockIdx: 3, content: 'SELECT 2;' },
    ]);
  });

  it('超过上限只取前 N 块（其余保留手动）', () => {
    const blocks = Array.from({ length: AUTO_SQL_BLOCK_LIMIT + 2 }, (_, i) => '```sql\nSELECT ' + i + ';\n```').join('\n');
    const out = autoExecutableSqlBlocks(blocks);
    expect(out).toHaveLength(AUTO_SQL_BLOCK_LIMIT);
    expect(out[0]).toEqual({ blockIdx: 0, content: 'SELECT 0;' }); // 连续围栏无中间文本块
  });

  it('无 SQL 块返回空数组', () => {
    expect(autoExecutableSqlBlocks('纯文本回复，没有代码块')).toEqual([]);
    expect(autoExecutableSqlBlocks('```json\n{"a":1}\n```')).toEqual([]);
  });
});

describe('formatToolResultContent（toolResult 展示格式化，内联/尾泡共用）', () => {
  it('markdown：标题 + 正文', () => {
    const r = formatToolResultContent({ title: 'Query result · 2 rows', content: '| a |\n|---|\n| 1 |', format: 'markdown' });
    expect(r.content).toBe('Query result · 2 rows\n\n| a |\n|---|\n| 1 |');
    expect(r.error).toBe(false);
  });

  it('非 markdown：标题 + 围栏代码块（带 lang）', () => {
    const r = formatToolResultContent({ title: 'Redis', content: 'OK', lang: 'redis' });
    expect(r.content).toBe('Redis\n\n```redis\nOK\n```');
  });

  it('错误结果带 error 标记', () => {
    expect(formatToolResultContent({ title: 'x failed', isError: true }).error).toBe(true);
  });
});

describe('isForeignSession（生成中切会话的分片守卫）', () => {
  it('两端都有值且不等 → 外来', () => {
    expect(isForeignSession('s1', 's2')).toBe(true);
  });
  it('同会话 → 非外来', () => {
    expect(isForeignSession('s1', 's1')).toBe(false);
  });
  it('新会话首发（webview 尚无 activeId）/ 消息无 sessionId → 不丢', () => {
    expect(isForeignSession(undefined, 's1')).toBe(false);
    expect(isForeignSession('', 's1')).toBe(false);
    expect(isForeignSession('s1', undefined)).toBe(false);
    expect(isForeignSession('s1', '')).toBe(false);
  });
});
