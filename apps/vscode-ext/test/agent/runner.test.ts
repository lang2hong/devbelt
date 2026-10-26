import { describe, expect, it } from 'vitest';
import type { ChatRequest, ChatStreamChunk, ToolCall } from '@devbelt/ai-core';
import { AgentRunner } from '../../src/agent/runner.js';
import type { AgentModel, AgentToolExecutor, ToolOutcome } from '../../src/agent/runner.js';

const toolDefs = [{
  type: 'function' as const,
  function: { name: 'run_read_only_query', description: 'q', parameters: { type: 'object', properties: {}, additionalProperties: false } },
}];

function call(name: string, args: unknown, id = 'c1'): ToolCall {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

function modelWith(turns: Array<{ text?: string; calls?: ToolCall[] } | Error>): { model: AgentModel; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let turn = 0;
  const model: AgentModel = {
    async *stream(request) {
      requests.push(request);
      const next = turns[turn++];
      if (next === undefined) throw new Error('unexpected model turn');
      if (next instanceof Error) throw next;
      yield { delta: next.text ?? '' } as ChatStreamChunk;
      if (next.calls && next.calls.length > 0) {
        yield {
          toolCalls: next.calls.map((c, index) => ({ index, id: c.id, function: { name: c.function.name, arguments: c.function.arguments } })),
        } as ChatStreamChunk;
      }
      yield { finishReason: 'stop' } as ChatStreamChunk;
    },
  };
  return { model, requests };
}

function executor(outcomes: Record<string, ToolOutcome> = {}): AgentToolExecutor & { calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  return {
    calls,
    async execute(call, args) {
      calls.push({ name: call.function.name, args });
      return outcomes[call.function.name] ?? { content: 'ok', summary: 'ok' };
    },
  };
}

const allowGuard = (args: unknown) => ({ allowed: true as const, tool: toolDefs[0]!, args: (args ?? {}) as Record<string, unknown>, requiresApproval: false });

function runner(turns: Parameters<typeof modelWith>[0], opts: Partial<ConstructorParameters<typeof AgentRunner>[0]> = {}, exec = executor()) {
  const { model, requests } = modelWith(turns);
  const guardCalls: Array<{ name: string; args: unknown }> = [];
  const r = new AgentRunner({
    model: 'm',
    tools: toolDefs,
    model_: model,
    guard: (name, args) => { guardCalls.push({ name, args }); return allowGuard(args); },
    executor: exec,
    signal: new AbortController().signal,
    ...opts,
  });
  return { r, requests, exec, guardCalls };
}

describe('AgentRunner', () => {
  it('finishes after a text-only model turn', async () => {
    const { r, requests } = runner([{ text: 'hello' }]);
    const result = await r.run([{ role: 'user', content: 'hi' }]);
    expect(result).toMatchObject({ content: 'hello', stopReason: 'completed', steps: [] });
    expect(requests[0]!.tools).toEqual(toolDefs);
    expect(requests[0]!.toolChoice).toBe('auto');
  });

  it('runs multiple tool calls serially and feeds results back', async () => {
    const exec = executor({ run_read_only_query: { content: '{"rows":2}', summary: '读取 2 行' } });
    const { r, requests, guardCalls } = runner([
      { text: 'checking', calls: [call('run_read_only_query', { sql: 'SELECT 1' }, 'c1'), call('run_read_only_query', { sql: 'SELECT 2' }, 'c2')] },
      { text: 'done' },
    ], {}, exec);
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.stopReason).toBe('completed');
    expect(result.content).toBe('checkingdone');
    expect(exec.calls.map((c) => c.args)).toEqual([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
    expect(guardCalls).toHaveLength(2);
    const second = requests[1]!.messages;
    expect(second.find((m) => m.role === 'assistant')?.toolCalls).toHaveLength(2);
    expect(second.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('reports invalid JSON arguments as a failed step and keeps going', async () => {
    const exec = executor();
    const { r } = runner([
      { calls: [call('run_read_only_query', 'not-json')] },
      { text: 'done' },
    ], {}, exec);
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(exec.calls).toHaveLength(0);
    expect(result.steps[0]).toMatchObject({ status: 'error', errorCode: 'invalid_arguments' });
    expect(result.stopReason).toBe('completed');
  });

  it('reports a guard rejection as a failed step', async () => {
    const { model } = modelWith([{ calls: [call('run_read_only_query', { sql: 'DELETE FROM t' })] }, { text: 'ok' }]);
    const r = new AgentRunner({
      model: 'm', tools: toolDefs, model_: model, guard: () => ({ allowed: false, reason: 'forbidden_keyword', detail: 'DELETE' }),
      executor: executor(), signal: new AbortController().signal,
    });
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.steps[0]).toMatchObject({ status: 'error', errorCode: 'forbidden_keyword' });
  });

  it('stops at the step limit', async () => {
    const turns = Array.from({ length: 5 }, () => ({ calls: [call('run_read_only_query', { sql: 'SELECT 1' })] }));
    const { r } = runner(turns, { maxSteps: 2 });
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toHaveLength(2);
  });

  it('stops at the tool-call limit', async () => {
    const { r } = runner([{ calls: [call('run_read_only_query', {}, 'a'), call('run_read_only_query', {}, 'b')] }], { maxToolCalls: 1 });
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.stopReason).toBe('max_tool_calls');
    expect(result.steps).toHaveLength(1);
  });

  it('stops when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { r, requests } = runner([{ text: 'nope' }], { signal: controller.signal });
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.stopReason).toBe('aborted');
    expect(requests).toHaveLength(0);
  });

  it('returns timeout when the deadline has passed', async () => {
    const { r } = runner([{ text: 'nope' }], { timeoutMs: 0 });
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.stopReason).toBe('timeout');
  });

  it('falls back to a tool-less turn when the provider rejects tools with 400', async () => {
    const err = Object.assign(new Error('tools are not supported'), { status: 400 });
    const { r, requests } = runner([err, { text: 'plain answer' }]);
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result).toMatchObject({ content: 'plain answer', stopReason: 'completed', degraded: true });
    expect(requests[0]!.tools).toEqual(toolDefs);
    expect(requests[1]!.tools).toBeUndefined();
  });

  it('does not degrade on a 400 that is not about tools', async () => {
    const err = Object.assign(new Error('AI request failed (HTTP 400): {"code":"VALIDATION_FAILED","message":"messages total length exceeds 120000 characters"}'), { status: 400 });
    const { r, requests } = runner([err]);
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result.degraded).toBeUndefined();
    expect(result.stopReason).toBe('model_error');
    expect(result.error).toContain('messages total length exceeds');
    expect(requests).toHaveLength(1); // 没有无工具重试
  });

  it('records why the tool definitions were rejected', async () => {
    const err = Object.assign(new Error('AI request failed (HTTP 400): tools[0].function.name is invalid'), { status: 400 });
    const { r } = runner([err, { text: 'plain' }]);
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result).toMatchObject({ degraded: true, degradedReason: expect.stringContaining('tools[0]') });
  });

  it('surfaces a model error without retrying unrelated failures', async () => {
    const { r, requests } = runner([new Error('boom')]);
    const result = await r.run([{ role: 'user', content: 'go' }]);
    expect(result).toMatchObject({ stopReason: 'model_error', error: 'boom' });
    expect(requests).toHaveLength(1);
  });

  it('emits step events in order', async () => {
    const events: string[] = [];
    const { r } = runner([{ calls: [call('run_read_only_query', { sql: 'SELECT 1' })] }, { text: 'done' }], {
      onEvent: (e) => events.push(e.type === 'step-start' ? `start:${e.tool}` : e.type === 'step-end' ? `end:${e.step.status}` : 'text'),
    });
    await r.run([{ role: 'user', content: 'go' }]);
    expect(events).toEqual(['start:run_read_only_query', 'end:ok', 'text']);
  });
});