import type { InjectionKey } from 'vue';

/**
 * in-chat 执行派发（P9 内联结果）：CodeBlock 经 inject 上抛，由 AIChatView 统一
 * 组装 blockRef（消息下标 + 块下标 + **消息代次**——代次只在视图根可取，故必须
 * 收口到根组件派发，不能在 CodeBlock 直接 post）。
 */
export interface RunInChatPayload {
  kind: 'sql' | 'redis' | 'es';
  text: string;
  msgIdx?: number;
  blockIdx?: number;
}

export type RunInChatDispatcher = (payload: RunInChatPayload) => void;

/** 慢查询「让 AI 优化」派发（根组件处理：追加用户消息 + 上行 optimizeSql）。 */
export type OptimizeSqlDispatcher = (sql: string, costMs?: number) => void;
export const OPTIMIZE_SQL_KEY: InjectionKey<OptimizeSqlDispatcher> = Symbol('ai-optimize-sql');

export const RUN_IN_CHAT_KEY: InjectionKey<RunInChatDispatcher> = Symbol('ai-run-in-chat');
