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
    if (args.kind === 'newRows') {
      // 只接受表里真实存在的递增列（kind 是 varchar，不能当游标）。
      expect(['id', 'received_time', 'event_time']).toContain(args.cursorColumn);
    } else {
      // 指标：必须是针对这张表的 SELECT，并指定要比较的列。
      expect(String(args.sql ?? '')).toMatch(/^\s*select\b[\s\S]*\blc_data_event\b/i);
      expect(typeof args.watchColumn === 'string' && args.watchColumn.length > 0, JSON.stringify(args)).toBe(true);
    }
  }, 90_000);

  it('leaves the alert condition to the user when only the metric is given', async () => {
    const calls = await callsFor([
      { role: 'system', content: 'You are a database assistant. Use tools. Reply in Chinese.' },
      { role: 'user', content: '监控 lc_data_event 每分钟的上传量。' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"lc_data_event"}' } }] },
      { role: 'tool', toolCallId: 'd1', content: JSON.stringify({ name: 'lc_data_event', columns: [
        { name: 'id', type: 'bigint', primaryKey: true }, { name: 'received_time', type: 'bigint', comment: '接收时间（毫秒）' },
        { name: 'kind', type: 'varchar(32)' }], indexes: [{ name: 'PRIMARY', columns: ['id'] }] }) },
    ]);
    const proposals = calls.filter((c) => c.name === 'propose_monitor').map((c) => JSON.parse(c.args || '{}') as Record<string, unknown>);
    // 用户没说什么时候提醒。模型可以给建议，但卡片上必须由用户点「采用」后才生效，
    // 所以这里只检查建议本身是形如「低于/高于 N」的阈值，而不是自动生效。
    for (const a of proposals) {
      if (a.conditionType === undefined) continue;
      expect(['anyChange', 'below', 'above'], JSON.stringify(a)).toContain(a.conditionType);
      if (a.conditionType !== 'anyChange') expect(Number.isFinite(Number(a.conditionValue)), JSON.stringify(a)).toBe(true);
    }
  }, 90_000);

  it('maps an explicit threshold to the matching condition', async () => {
    const calls = await callsFor([
      { role: 'system', content: 'You are a database assistant. Use tools. Reply in Chinese.' },
      { role: 'user', content: '监控 lc_batch，如果每 10 分钟新增的行数少于 50 就提醒我。' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"lc_batch"}' } }] },
      { role: 'tool', toolCallId: 'd1', content: JSON.stringify({ name: 'lc_batch', columns: [
        { name: 'id', type: 'bigint', primaryKey: true }, { name: 'received_time', type: 'bigint' }], indexes: [{ name: 'PRIMARY', columns: ['id'] }] }) },
    ]);
    const propose = calls.find((c) => c.name === 'propose_monitor');
    expect(propose, JSON.stringify(calls)).toBeTruthy();
    const args = JSON.parse(propose!.args || '{}') as Record<string, unknown>;
    expect(args.conditionType).toBe('below');
    expect(Number(args.conditionValue)).toBe(50);
    expect(Number(args.intervalMinutes)).toBe(10);
  }, 90_000);

  it('does not invent a cursor column when the table has none', async () => {
    const calls = await callsFor([
      { role: 'system', content: 'You are a database assistant. Use tools. Reply in Chinese.' },
      { role: 'user', content: '帮我监控 tags 表有没有新增的行。' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'd1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"tags"}' } }] },
      { role: 'tool', toolCallId: 'd1', content: JSON.stringify({ name: 'tags', columns: [{ name: 'code', type: 'varchar(20)', primaryKey: true }, { name: 'title', type: 'varchar(100)' }], indexes: [] }) },
    ]);
    const columns = [{ name: 'code', type: 'varchar(20)' }, { name: 'title', type: 'varchar(100)' }];
    // 合法游标：表里真实存在、且是整数或时间类型的列（这张表一个都没有）。
    const validCursors = columns.filter((c) => /int|date|time/i.test(c.type)).map((c) => c.name);
    const newRows = calls.filter((c) => c.name === 'propose_monitor').map((c) => JSON.parse(c.args || '{}') as Record<string, unknown>).filter((a) => a.kind === 'newRows');
    // 要么不提新增行监控；要么提出时游标列必须是真实存在且类型合法的列。
    for (const a of newRows) expect(validCursors, JSON.stringify(a)).toContain(a.cursorColumn);
  }, 90_000);
});
