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
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
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
  content: string;
  usage?: TokenUsage;
  model: string;
}

export interface ChatStreamChunk {
  /** 增量文本。 */
  delta?: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | null;
  /** 通常在 finish chunk 返回（取决于上游是否开启 usage 上报）。 */
  usage?: TokenUsage;
}