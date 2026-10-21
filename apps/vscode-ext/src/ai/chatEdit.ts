import type { AiChatMessage } from './aiSessionStore.js';

/** 重新生成前丢弃尾部 assistant/error；保留最后一条 user 作为重发内容。 */
export function dropTrailingAssistant(messages: AiChatMessage[]): void {
  while (messages.length > 0 && messages[messages.length - 1]!.role === 'assistant') {
    messages.pop();
  }
}

/** 编辑第 index 条 user 消息：截断该条及其后的历史，并写入新文本；非法下标返回 undefined。 */
export function replaceUserMessage(messages: AiChatMessage[], index: number, text: string): AiChatMessage[] | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= messages.length) return undefined;
  if (messages[index]!.role !== 'user') return undefined;
  return [...messages.slice(0, index), { role: 'user', content: text }];
}