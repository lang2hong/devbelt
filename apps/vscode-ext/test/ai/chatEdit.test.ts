import { describe, expect, it } from 'vitest';
import { dropTrailingAssistant, replaceUserMessage } from '../../src/ai/chatEdit';
import type { AiChatMessage } from '../../src/ai/aiSessionStore';

const u = (content: string): AiChatMessage => ({ role: 'user', content });
const a = (content: string, error = false): AiChatMessage => ({ role: 'assistant', content, ...(error ? { error: true } : {}) });

describe('dropTrailingAssistant', () => {
  it('丢弃尾部 assistant 与 error，保留最后 user', () => {
    const messages = [u('q1'), a('a1'), u('q2'), a('failed', true)];
    dropTrailingAssistant(messages);
    expect(messages).toEqual([u('q1'), a('a1'), u('q2')]);
  });

  it('尾部是 user 时保持不变', () => {
    const messages = [u('q1')];
    dropTrailingAssistant(messages);
    expect(messages).toEqual([u('q1')]);
  });
});

describe('replaceUserMessage', () => {
  it('截断该 user 之后的历史并替换文本', () => {
    const messages = [u('q1'), a('a1'), u('q2'), a('a2')];
    expect(replaceUserMessage(messages, 2, 'q2-edited')).toEqual([u('q1'), a('a1'), u('q2-edited')]);
  });

  it('非 user / 越界返回 undefined', () => {
    const messages = [u('q1'), a('a1')];
    expect(replaceUserMessage(messages, 1, 'x')).toBeUndefined();
    expect(replaceUserMessage(messages, -1, 'x')).toBeUndefined();
    expect(replaceUserMessage(messages, 2, 'x')).toBeUndefined();
    expect(replaceUserMessage(messages, 0.5, 'x')).toBeUndefined();
  });
});