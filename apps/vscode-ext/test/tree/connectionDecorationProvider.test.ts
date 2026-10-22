import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    private readonly ls: ((x: unknown) => void)[] = [];
    event = (l: (x: unknown) => void) => { this.ls.push(l); return { dispose(): void { /* noop */ } }; };
    fire(x?: unknown): void { for (const l of this.ls) l(x); }
    dispose(): void { /* noop */ }
  },
  ThemeColor: class { constructor(public id: string) { /* noop */ } },
}));

import { ConnectionDecorationProvider } from '../../src/tree/connectionDecorationProvider';

function storeWith(conn: { id: string; environment?: string; color?: string }) {
  let listener: (() => void) | undefined;
  return {
    get: (id: string) => (conn.id === id ? conn : undefined),
    onChanged: (l: () => void) => { listener = l; return { dispose() { /* noop */ } }; },
    fire: () => listener?.(),
  };
}

describe('ConnectionDecorationProvider', () => {
  it('scheme 过滤：非 devbelt-conn 一律 undefined', () => {
    const p = new ConnectionDecorationProvider(storeWith({ id: 'c1', environment: 'production' }) as never);
    expect(p.provideFileDecoration({ scheme: 'file', authority: 'c1' } as never)).toBeUndefined();
  });

  it('未知连接返回 undefined；命中返回主题色', () => {
    const p = new ConnectionDecorationProvider(storeWith({ id: 'c1', environment: 'production' }) as never);
    expect(p.provideFileDecoration({ scheme: 'devbelt-conn', authority: 'nope' } as never)).toBeUndefined();
    const deco = p.provideFileDecoration({ scheme: 'devbelt-conn', authority: 'c1' } as never);
    expect(deco?.badge).toBeUndefined();
    expect((deco?.color as unknown as { id: string })?.id).toBe('errorForeground');
  });

  it('未知环境/development 返回 undefined', () => {
    const unknown = new ConnectionDecorationProvider(storeWith({ id: 'c1', environment: 'sandbox' }) as never);
    expect(unknown.provideFileDecoration({ scheme: 'devbelt-conn', authority: 'c1' } as never)).toBeUndefined();
    const dev = new ConnectionDecorationProvider(storeWith({ id: 'c1', environment: 'development' }) as never);
    expect(dev.provideFileDecoration({ scheme: 'devbelt-conn', authority: 'c1' } as never)).toBeUndefined();
  });

  it('store 变更触发 onDidChangeFileDecorations（防装饰 stale）', () => {
    const store = storeWith({ id: 'c1', environment: 'production' });
    const p = new ConnectionDecorationProvider(store as never);
    let fired = 0;
    p.onDidChangeFileDecorations(() => { fired += 1; });
    store.fire();
    expect(fired).toBe(1);
    p.dispose();
  });
});