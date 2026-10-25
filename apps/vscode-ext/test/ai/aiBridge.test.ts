import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AiBridge } from '../../src/ai/aiBridge';

describe('AiBridge', () => {
  it('prefillChat 只转发文本，不构造请求', () => {
    const requestChat = vi.fn();
    const prefillChat = vi.fn();
    const bridge = AiBridge.init({ requestChat, prefillChat });

    expect(bridge.prefillChat('SELECT 1')).toBe(true);
    expect(prefillChat).toHaveBeenCalledWith('SELECT 1');
    expect(requestChat).not.toHaveBeenCalled();
    AiBridge.reset();
  });

  it('未初始化时调用方拿到 undefined，可以提示 AI 未启用', () => {
    AiBridge.reset();
    expect(AiBridge.tryGet()).toBeUndefined();
  });
});
