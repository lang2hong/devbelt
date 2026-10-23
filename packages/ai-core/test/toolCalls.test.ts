import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider, parseToolCalls, parseToolCallDeltas } from '../src/openaiCompatible.js';
import type { ChatRequest, ToolDefinition } from '../src/chat.js';

const tools: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'describe_table',
    description: 'Describe a table',
    parameters: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
  },
}];

function recording(response: Response): { bodies: any[]; fetchImpl: typeof fetch } {
  const bodies: any[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return response;
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

function provider(fetchImpl: typeof fetch) {
  return new OpenAICompatibleProvider({ baseUrl: 'https://ai.test/v1', apiKey: 'k', fetchImpl });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const base: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('tool calling request payload', () => {
  it('sends tools / tool_choice and serializes tool messages', async () => {
    const { bodies, fetchImpl } = recording(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const request: ChatRequest = {
      ...base,
      tools,
      toolChoice: 'required',
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"t"}' } }] },
        { role: 'tool', content: '{"rows":1}', toolCallId: 'call_1' },
      ],
    };
    await provider(fetchImpl).chat(request);
    const body = bodies[0];
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('required');
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"t"}' } }],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', content: '{"rows":1}', tool_call_id: 'call_1' });
  });

  it('keeps the payload unchanged when no tools are passed', async () => {
    const { bodies, fetchImpl } = recording(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await provider(fetchImpl).chat(base);
    expect(Object.keys(bodies[0]).sort()).toEqual(['messages', 'model', 'stream']);
    expect(bodies[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('does not send tool_choice without tools', async () => {
    const { bodies, fetchImpl } = recording(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await provider(fetchImpl).chat({ ...base, toolChoice: 'auto' });
    expect(bodies[0].tool_choice).toBeUndefined();
  });
});

describe('tool calling response parsing', () => {
  it('parses tool calls when content is null', async () => {
    const { fetchImpl } = recording(jsonResponse({
      model: 'm',
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"t"}' } }] } }],
    }));
    const res = await provider(fetchImpl).chat(base);
    expect(res.content).toBe('');
    expect(res.toolCalls).toEqual([{ id: 'c1', type: 'function', function: { name: 'describe_table', arguments: '{"table":"t"}' } }]);
  });

  it('still rejects a response with neither content nor tool calls', async () => {
    const { fetchImpl } = recording(jsonResponse({ choices: [{ message: {} }] }));
    await expect(provider(fetchImpl).chat(base)).rejects.toThrow(/missing choices/);
  });

  it('streams tool-call deltas alongside content', async () => {
    const events = [
      { choices: [{ delta: { content: '' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'describe_', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"table"' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"t"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ];
    const { fetchImpl } = recording(sseResponse(events));
    const chunks: any[] = [];
    for await (const chunk of provider(fetchImpl).chatStream(base)) chunks.push(chunk);
    const calls = chunks.flatMap((c) => c.toolCalls ?? []);
    expect(calls.map((c) => [c.index, c.id, c.function?.name, c.function?.arguments])).toEqual([
      [0, 'c1', 'describe_', undefined],
      [0, undefined, undefined, '{"table"'],
      [0, undefined, undefined, ':"t"}'],
    ]);
  });
});

describe('parse helpers', () => {
  it('ignores malformed tool calls instead of throwing', () => {
    expect(parseToolCalls(undefined)).toEqual([]);
    expect(parseToolCalls([{ id: 1 }, { id: 'c', type: 'function' }, { id: 'c', function: { name: 'n', arguments: { a: 1 } } }]))
      .toEqual([{ id: 'c', type: 'function', function: { name: 'n', arguments: '{"a":1}' } }]);
  });

  it('drops tool-call deltas without a valid index', () => {
    expect(parseToolCallDeltas([{ function: { name: 'x' } }, { index: -1 }, { index: 0, id: 'a' }]))
      .toEqual([{ index: 0, id: 'a' }]);
  });
});