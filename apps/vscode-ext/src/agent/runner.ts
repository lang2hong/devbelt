import type { ChatMessage, ChatRequest, ChatStreamChunk, ToolCall, ToolDefinition } from '@devbelt/ai-core';

/** Minimal guard contract (structurally compatible with agent-core's GuardResult). */
export type AgentGuardResult =
  | { allowed: true; args: Record<string, unknown>; requiresApproval: boolean }
  | { allowed: false; reason: string; detail?: string };

/** The model side of one agent turn: a streamed chat request. */
export interface AgentModel {
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatStreamChunk>;
}

/** Executes one validated tool call. Must not throw for expected failures. */
export interface AgentToolExecutor {
  execute(call: ToolCall, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface ToolOutcome {
  /** JSON/text handed back to the model as the tool message. */
  content: string;
  isError?: boolean;
  /** Short human-readable line for the step list. */
  summary?: string;
  /** Stable rejection/failure code for the step list. */
  errorCode?: string;
}

export interface AgentStep {
  index: number;
  tool: string;
  status: 'ok' | 'error';
  durationMs: number;
  summary?: string;
  errorCode?: string;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'step-start'; index: number; tool: string }
  | { type: 'step-end'; step: AgentStep };

export type AgentStopReason = 'completed' | 'max_steps' | 'max_tool_calls' | 'timeout' | 'aborted' | 'model_error';

export interface AgentRunResult {
  content: string;
  steps: AgentStep[];
  stopReason: AgentStopReason;
  /** Set when the provider rejected tools and the turn was retried without them. */
  degraded?: boolean;
  /** 降级时上游 / 服务端给出的原始错误（已截断），用于界面提示。 */
  degradedReason?: string;
  error?: string;
}

export interface AgentRunnerOptions {
  model: string;
  temperature?: number;
  tools: ToolDefinition[];
  model_: AgentModel;
  guard: (toolName: string, args: unknown) => AgentGuardResult;
  executor: AgentToolExecutor;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_TOOL_CALLS = 24;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * One user turn of the read-only agent: call the model, run the tool calls it
 * returns (serial), feed the results back, repeat until the model answers
 * without tool calls or a limit is hit.
 *
 * Authorisation lives in `guard` and in the tool executor (read-only runtime);
 * this loop only enforces the step/budget limits and abort handling.
 */
export class AgentRunner {
  constructor(private readonly opts: AgentRunnerOptions) {}

  async run(messages: ChatMessage[]): Promise<AgentRunResult> {
    const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxToolCalls = this.opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const deadline = Date.now() + (this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const transcript: ChatMessage[] = [...messages];
    const steps: AgentStep[] = [];
    let content = '';
    let toolCalls = 0;

    for (let step = 0; step < maxSteps;) {
      if (this.opts.signal.aborted) return { content, steps, stopReason: 'aborted' };
      if (Date.now() >= deadline) return { content, steps, stopReason: 'timeout' };

      let response: { text: string; calls: ToolCall[] };
      try {
        response = await this.streamTurn(transcript);
      } catch (err) {
        // 明确是「工具定义被拒绝」时才降级重试；其他 400 原样报错（不再吞掉真实原因）。
        if (step === 0 && content === '' && isToolUnsupported(err)) {
          try {
            const plain = await this.streamTurn(transcript, false);
            return { content: plain.text, steps, stopReason: 'completed', degraded: true, degradedReason: truncate(messageOf(err), 200) };
          } catch (retryErr) {
            return { content, steps, stopReason: 'model_error', error: messageOf(retryErr) };
          }
        }
        if (this.opts.signal.aborted) return { content, steps, stopReason: 'aborted' };
        return { content, steps, stopReason: 'model_error', error: messageOf(err) };
      }

      content += response.text;
      if (response.calls.length === 0) return { content, steps, stopReason: 'completed' };

      // The assistant message carrying the tool calls must precede the results.
      transcript.push({ role: 'assistant', content: response.text, toolCalls: response.calls });

      for (const call of response.calls) {
        toolCalls += 1;
        if (toolCalls > maxToolCalls) return { content, steps, stopReason: 'max_tool_calls' };
        if (this.opts.signal.aborted) return { content, steps, stopReason: 'aborted' };
        if (Date.now() >= deadline) return { content, steps, stopReason: 'timeout' };

        const index = steps.length + 1;
        this.opts.onEvent?.({ type: 'step-start', index, tool: call.function.name });
        const started = Date.now();
        const outcome = await this.runTool(call);
        const stepResult: AgentStep = {
          index,
          tool: call.function.name,
          status: outcome.isError ? 'error' : 'ok',
          durationMs: Date.now() - started,
          ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
          ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
        };
        steps.push(stepResult);
        this.opts.onEvent?.({ type: 'step-end', step: stepResult });
        transcript.push({ role: 'tool', content: outcome.content, toolCallId: call.id });
      }
      step += 1;
    }
    return { content, steps, stopReason: 'max_steps' };
  }

  /** Stream one model turn, emitting text and collecting tool-call fragments. */
  private async streamTurn(messages: ChatMessage[], withTools = true): Promise<{ text: string; calls: ToolCall[] }> {
    const request: ChatRequest = {
      model: this.opts.model,
      messages,
      ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      ...(withTools && this.opts.tools.length > 0 ? { tools: this.opts.tools, toolChoice: 'auto' as const } : {}),
    };
    const calls = new Map<number, { id?: string; name: string; args: string }>();
    let text = '';
    for await (const chunk of this.opts.model_.stream(request, this.opts.signal)) {
      if (this.opts.signal.aborted) break;
      if (chunk.delta) {
        text += chunk.delta;
        this.opts.onEvent?.({ type: 'text', delta: chunk.delta });
      }
      for (const part of chunk.toolCalls ?? []) {
        const cur = calls.get(part.index) ?? { name: '', args: '' };
        calls.set(part.index, {
          ...(part.id ? { id: part.id } : cur.id ? { id: cur.id } : {}),
          name: part.function?.name ? cur.name + part.function.name : cur.name,
          args: part.function?.arguments ? cur.args + part.function.arguments : cur.args,
        });
      }
    }
    const out: ToolCall[] = [];
    for (const [, c] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      if (!c.id || !c.name) continue;
      out.push({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } });
    }
    return { text, calls: out };
  }

  private async runTool(call: ToolCall): Promise<ToolOutcome & { errorCode?: string }> {
    let args: unknown;
    try {
      args = call.function.arguments.trim() === '' ? {} : JSON.parse(call.function.arguments);
    } catch {
      return { content: 'Tool arguments are not valid JSON.', isError: true, errorCode: 'invalid_arguments', summary: '参数不是合法 JSON' };
    }
    const guarded = this.opts.guard(call.function.name, args);
    if (!guarded.allowed) {
      return {
        content: `Tool call rejected: ${guarded.reason}${guarded.detail ? ` (${guarded.detail})` : ''}.`,
        isError: true,
        errorCode: guarded.reason,
        summary: `被拒绝：${guarded.reason}`,
      };
    }
    try {
      return await this.opts.executor.execute(call, guarded.args, this.opts.signal);
    } catch (err) {
      return { content: `Tool failed: ${messageOf(err)}`, isError: true, errorCode: 'tool_failed', summary: '工具执行失败' };
    }
  }
}

/**
 * 是否「工具定义本身被拒绝」。只有错误内容明确提到 tools / tool_choice / function
 * 才算：服务端 400 还可能是上下文超长、字段格式等，那些必须原样报错，
 * 否则会被误标成「模型不支持工具调用」。
 */
function isToolUnsupported(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string } | null;
  if (!e) return false;
  const message = typeof e.message === 'string' ? e.message : '';
  if (!/\btools?\b|tool_choice|\btool_calls?\b|function_call/i.test(message)) return false;
  return e.status === 400 || e.code === 'AI_NETWORK_ERROR';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}