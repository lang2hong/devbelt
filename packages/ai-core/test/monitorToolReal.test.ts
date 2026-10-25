import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../src/openaiCompatible.js';

/**
 * P13 本地真模型检查（不进 CI）：模型应先看表结构，再用真实存在的列调用 propose_monitor；
 * 表里没有合适游标列时不应编造列名去提 newRows。
 *   DEVBELT_TEST_REAL_MODEL=1 DASHSCOPE_API_KEY=... pnpm -C packages/ai-core exec vitest run test/monitorToolReal.test.ts
 */
const enabled = process.env.DEVBELT_TEST_REAL_MODEL === '1' && !!process.env.DASHSCOPE_API_KEY;
const model = process.env.DEVBELT_TEST_MODEL || 'deepseek-v4.1-flash';

const PROPOSE = {
  type: 'function' as const,
  function: {
    name: 'propose_monitor',
    description: 'Propose a background monitoring task for a table on the current connection. It is NOT created until the user confirms. kind=rowCount watches COUNT(*). kind=metric: one read-only SELECT returning 1 row and 1-10 numeric columns; watchColumn is compared. kind=newRows: cursorColumn must be an existing monotonically increasing integer or datetime/timestamp column (use describe_table first; never invent a column). If the table has no such column, do not call this tool with newRows: suggest rowCount or a metric instead.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['rowCount', 'metric', 'newRows'] },
        table: { type: 'string' },
        sql: { type: 'string' },
        watchColumn: { type: 'string' },
        cursorColumn: { type: 'string' },
        intervalMinutes: { type: 'integer' },
        conditionType: { type: 'string', enum: ['anyChange', 'increaseBy', 'decreaseBy', 'changePercent', 'above', 'below'] },
        conditionValue: { type: 'number' },
      },
      required: ['kind', 'table'],
      additionalProperties: false,
    },
  },
};
const DESCRIBE = { type: 'function' as const, function: { name: 'describe_table', description: 'Describe a table', parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'], additionalProperties: false } } };

async function callsFor(messages: Array<Record<string, unknown>>): Promise<Array<{ name?: string; args?: string }>> {
  const provider = new OpenAICompatibleProvider({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: process.env.DASHSCOPE_API_KEY, timeoutMs: 60_000 });
  const calls: Array<{ name?: string; args?: string }> = [];
  for await (const chunk of provider.chatStream({ model, messages: messages as never, tools: [DESCRIBE, PROPOSE], toolChoice: 'auto' })) {
    for (const part of chunk.toolCalls ?? []) {
      const cur = calls[part.index] ?? {};
      calls[part.index] = {
        ...(part.function?.name ? { name: (cur.name ?? '') + part.function.name } : cur.name ? { name: cur.name } : {}),
        args: (cur.args ?? '') + (part.function?.arguments ?? ''),
      };
    }
  }
  return calls.filter(Boolean);
}

describe.skipIf(!enabled)('real model propose_monitor', () => {
  it('uses the real cursor column for new rows', async () => {
    const calls = await callsFor([
      { role: 'system', content: 'You are a database assistant. Use tools. Reply in Chinese.' },
      { role: 'user', content: '帮我监控 lc_data_event 有没有新数据进来，每 5 分钟看一次，新增超过 10 条提醒我。' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"lc_data_event"}' } }] },
      { role: 'tool', toolCallId: 'd1', content: JSON.stringify({ name: 'lc_data_event', columns: [
        { name: 'id', type: 'bigint', primaryKey: true }, { name: 'received_time', type: 'bigint', comment: '接收时间（毫秒）' },
        { name: 'event_time', type: 'bigint' }, { name: 'kind', type: 'varchar(32)' }], indexes: [{ name: 'PRIMARY', columns: ['id'] }] }) },
    ]);
    const propose = calls.find((c) => c.name === 'propose_monitor');
    expect(propose, JSON.stringify(calls)).toBeTruthy();
    const args = JSON.parse(propose!.args || '{}') as Record<string, unknown>;
    expect(['newRows', 'metric']).toContain(args.kind);
    if (args.kind === 'newRows') expect(['id', 'received_time']).toContain(args.cursorColumn);
    expect(args.cursorColumn).not.toBe('create_time');
  }, 90_000);

  it('does not invent a cursor column when the table has none', async () => {
    const calls = await callsFor([
      { role: 'system', content: 'You are a database assistant. Use tools. Reply in Chinese.' },
      { role: 'user', content: '帮我监控 tags 表有没有新增的行。' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"tags"}' } }] },
      { role: 'tool', toolCallId: 'd1', content: JSON.stringify({ name: 'tags', columns: [{ name: 'code', type: 'varchar(20)', primaryKey: true }, { name: 'title', type: 'varchar(100)' }], indexes: [] }) },
    ]);
    const newRows = calls.filter((c) => c.name === 'propose_monitor').map((c) => JSON.parse(c.args || '{}') as Record<string, unknown>).filter((a) => a.kind === 'newRows');
    // Neither existing column is a valid cursor (varchar); any newRows proposal must not invent one.
    for (const a of newRows) expect(String(a.cursorColumn ?? '')).not.toMatch(/created|create_time|updated|time|id$/i);
  }, 90_000);
});
