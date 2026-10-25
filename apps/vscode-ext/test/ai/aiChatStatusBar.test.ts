import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  item: {
    command: '',
    text: '',
    tooltip: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  },
  create: vi.fn(),
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
  window: { createStatusBarItem: (...args: unknown[]) => { h.create(...args); return h.item; } },
}));

import { AiChatStatusBar } from '../../src/ai/aiChatStatusBar';

describe('AiChatStatusBar', () => {
  beforeEach(() => {
    h.create.mockClear();
    h.item.show.mockClear();
    h.item.dispose.mockClear();
    h.item.command = '';
    h.item.text = '';
    h.item.tooltip = '';
  });

  it('常驻显示，点击打开 AI 对话', () => {
    const bar = new AiChatStatusBar();
    expect(h.create).toHaveBeenCalledWith(2, 89);
    expect(h.item.command).toBe('devbelt.ai.chat');
    expect(h.item.text).toContain('comment-discussion');
    expect(h.item.tooltip).toBeTruthy();
    expect(h.item.show).toHaveBeenCalledTimes(1);
    bar.dispose();
    expect(h.item.dispose).toHaveBeenCalledTimes(1);
  });
});
