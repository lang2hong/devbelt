import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startNonceCleanup } from '../../src/service/nonceCleanup.js';

describe('nonceCleanup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('按周期执行 purge，stop 后停止', async () => {
    const purge = vi.fn(async () => {});
    const h = startNonceCleanup(purge, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(purge).toHaveBeenCalledTimes(2);
    h.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('purge 失败不抛出、不影响后续周期（重入闸：慢清理跳过 tick）', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const purge = vi.fn(() => {
      calls++;
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const h = startNonceCleanup(purge, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); // 仍在飞 → 跳过
    expect(calls).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    release();
    h.stop();
  });

  it('purge 抛错被吞掉，下个周期继续', async () => {
    const purge = vi.fn(async () => { throw new Error('db down'); });
    const h = startNonceCleanup(purge, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(purge).toHaveBeenCalledTimes(2);
    h.stop();
  });
});