import { SYSTEM_PROMPT } from './system.js';
import type { ChatMessage } from '../chat.js';

/** 以固定 system prompt + 场景 user 内容组装消息数组。 */
export function withSystem(userContent: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

/** 条件段落：body 为空时整段省略（避免 prompt 里出现空标题/undefined）。 */
export function section(title: string, body: string | undefined): string | undefined {
  const text = body?.trim();
  return text ? `${title}\n${text}` : undefined;
}

export function joinSections(sections: Array<string | undefined>): string {
  return sections.filter((s): s is string => Boolean(s && s.trim())).join('\n\n');
}

export function dialectLine(dbType: string | undefined): string | undefined {
  return dbType ? `Dialect: ${dbType}` : undefined;
}

export function codeBlock(text: string, lang?: string): string {
  return `\`\`\`${lang ?? ''}\n${text}\n\`\`\``;
}

/** 空内容返回 undefined（避免 prompt 里出现空代码块）。 */
export function optionalCodeBlock(text: string | undefined, lang?: string): string | undefined {
  return text?.trim() ? codeBlock(text, lang) : undefined;
}