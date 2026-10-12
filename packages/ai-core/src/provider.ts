import type { ChatRequest, ChatResponse, ChatStreamChunk } from './chat.js';

/**
 * 模型接入抽象。两个实现共用同一契约：
 *  - `openai-compatible`：用户自带 Key 直连任意 OpenAI 兼容服务；
 *  - `server-proxy`（客户端侧薄封装，复用本接口）：DevBelt 官方代理。
 */
export interface AiProvider {
  readonly id: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  chatStream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatStreamChunk>;
}