/**
 * 服务端代理上游配置（P9 §6.8）：单一 OpenAI 兼容上游，环境变量注入。
 *
 * - `DEVBELT_AI_UPSTREAM_BASE_URL`：兼容端点根地址（含版本段，如 `https://.../v1`）。
 * - `DEVBELT_AI_UPSTREAM_API_KEY`：上游 Key（可选：本地 Ollama/vLLM 可不校验）。
 * - `DEVBELT_AI_UPSTREAM_MODEL`：服务端固定模型名（不透传客户端模型，单一上游防滥用）。
 *
 * fail-closed：baseUrl 或 model 缺失时 `configured=false`，`/api/ai/chat` 一律 503
 * `AI_PROVIDER_ERROR`（不静默回落到某个默认上游）。
 */
export interface AiUpstreamConfig {
  configured: boolean;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export function resolveAiUpstreamConfig(env: NodeJS.ProcessEnv = process.env): AiUpstreamConfig {
  const baseUrl = env.DEVBELT_AI_UPSTREAM_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
  const apiKey = env.DEVBELT_AI_UPSTREAM_API_KEY?.trim() || undefined;
  const model = env.DEVBELT_AI_UPSTREAM_MODEL?.trim() || '';
  return {
    configured: Boolean(baseUrl && model),
    baseUrl,
    apiKey,
    model,
  };
}