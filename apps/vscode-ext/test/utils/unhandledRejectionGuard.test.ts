import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }),
  },
}));

import { installUnhandledRejectionGuard } from '../../src/utils/unhandledRejectionGuard';

/** process.emit 对 'unhandledRejection' 无 TS 重载，测试里用宽松签名触发。 */
const emitUnhandled = (reason: unknown): boolean =>
  (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit('unhandledRejection', reason);

describe('installUnhandledRejectionGuard', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => { uninstall?.(); uninstall = undefined; });

  it('接管模式：忽略 ioredis 内部关闭类，不抛出', () => {
    uninstall = installUnhandledRejectionGuard({ takeOver: true });
    expect(() => emitUnhandled(new Error('Connection is closed.'))).not.toThrow();
    expect(() => emitUnhandled(new Error('MaxRetriesPerRequestError: x'))).not.toThrow();
  });

  it('接管模式：其它未处理拒绝仍抛出（门禁对本产品代码成立）', () => {
    uninstall = installUnhandledRejectionGuard({ takeOver: true });
    expect(() => emitUnhandled(new Error('boom from our code'))).toThrow(/boom from our code/);
  });

  it('卸载后还原先前监听', () => {
    const before = process.listenerCount('unhandledRejection');
    const off = installUnhandledRejectionGuard({ takeOver: true });
    const during = process.listenerCount('unhandledRejection');
    off();
    expect(during).toBe(1);
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});