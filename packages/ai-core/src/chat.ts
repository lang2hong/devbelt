import type { TokenUsage } from './usage.js';

/** 调用来源标识（审计用；不发给模型）。 */
export type AiFeature =
  | 'chat'
  | 'nl2sql'
  | 'explain'
  | 'optimize'
  | 'error-diagnose'
  | 'data-qa'
  | 'schema-design'
  | 'inline-completion';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Text content. Empty is allowed for an assistant message that only returns
   * tool calls, and for `tool` messages that only carry a result.
   */
  content: string;
  /** Assistant messages: tool calls requested by the model. */
  toolCalls?: ToolCall[];
  /** `tool` messages: the id of the assistant tool call this result answers. */
  toolCallId?: string;
}

/** OpenAI-compatible function definition. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema object. */
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Streaming tool-call fragment; `index` groups fragments of the same call. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Only sent when present; providers without tool support reject the request upstream. */
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /**
   * 流式请求时是否让上游在最后一个 chunk 返回 usage 统计。
   * OpenAI/DashScope 兼容模式默认不返回 usage，必须显式传
   * `streamOptions: { includeUsage: true }` 才会附带。
   * 服务端代理转发时强制置 true，以完成 finish 对账。
   */
  streamOptions?: { includeUsage?: boolean };
  /** 仅用于本地审计/用量归类，不进请求体。 */
  feature?: AiFeature;
}

export interface ChatResponse {
  /** May be empty when the model only returned tool calls. */
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
}

export interface ChatStreamChunk {
  /** 增量文本。 */
  delta?: string;
  /** 工具调用增量（OpenAI 按 index 分片下发）。 */
  toolCalls?: ToolCallDelta[];
  /** 推理模型的思考过程增量（reasoning_content / reasoning；仅展示，不计费、不入正文）。 */
  reasoning?: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | null;
  /** 通常在 finish chunk 返回（取决于上游是否开启 usage 上报）。 */
  usage?: TokenUsage;
}