import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startInvitationCleanup } from '../../src/service/invitationCleanup.js';

describe('invitationCleanup re-entrancy gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('skips a tick while the previous expire is still in flight', async () => {
    let calls = 0;
    let release: () => void = () => {};
    // 每轮返回一个由测试手动放行的 pending promise，模拟慢清理。
    const expire = vi.fn(() => {
      calls++;
      return new Promise<void>((resolve) => { release = resolve; });
    });

    const started = startInvitationCleanup(expire, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000); // 第一轮开始，未结束
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(2000); // 两轮 tick 期间第一轮仍未结束 → 跳过
    expect(calls).toBe(1);

    release(); // 放行第一轮，running 复位
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000); // 空闲后恢复
    expect(calls).toBe(2);

    release();
    started.stop();
  });
});