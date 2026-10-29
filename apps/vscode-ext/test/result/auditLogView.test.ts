import { beforeEach, describe, expect, it, vi } from 'vitest';

// BaseWebView 替身：记录实例，dispose 走真实 onDispose（子类会清单例引用）。
const h = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('vscode', () => ({ window: {}, workspace: {} }));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    post = vi.fn();
    initSent = false;
    disposed = false;
    constructor(..._args: unknown[]) { h.instances.push(this); }
    dispose(): void { this.onDispose(); this.disposed = true; }
    onDispose(): void { /* 子类覆盖 */ }
    reveal(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/auditLogger', () => ({ AuditLogger: class {} }));

import { AuditLogView } from '../../src/result/auditLogView';

beforeEach(() => { h.instances.length = 0; });

describe('AuditLogView 单例生命周期', () => {
  it('open() 替换旧面板；closeAll()（账号切换）关闭并清空，可重新打开', () => {
    const logger = {} as never;
    AuditLogView.open(logger);
    expect(h.instances).toHaveLength(1);

    AuditLogView.open(logger);
    expect(h.instances).toHaveLength(2);
    expect(h.instances[0].disposed).toBe(true);
    expect(h.instances[1].disposed).toBe(false);

    AuditLogView.closeAll();
    expect(h.instances[1].disposed).toBe(true);
    expect(() => AuditLogView.closeAll()).not.toThrow();

    AuditLogView.open(logger);
    expect(h.instances[2].disposed).toBe(false);
  });

  it('两段 ready 协议：先 init 后 entries', async () => {
    const logger = {
      getEntries: vi.fn(() => [{ action: 'query_execute', time: 1, sql: 'SELECT 1' }]),
      clear: vi.fn(),
    } as never;
    AuditLogView.open(logger);
    const view = h.instances[0];

    await view.handleMessage({ type: 'ready' });
    expect(view.post).toHaveBeenCalledWith({ type: 'init', mode: 'auditLog' });

    await view.handleMessage({ type: 'ready' });
    const last = view.post.mock.calls.at(-1)[0];
    expect(last.type).toBe('entries');
    expect(last.entries).toHaveLength(1);
  });
});
