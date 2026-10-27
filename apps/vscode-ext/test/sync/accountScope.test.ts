import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  accountScope, onAccountScopeChange, readScoped, scopedKey, scopedPrefix,
  setAccountScope, writeScoped,
} from '../../src/sync/accountScope';

/** 最小 Memento：键值 + update 计数。 */
function memento(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get<T>(key: string): T | undefined { return data[key] as T | undefined; },
    update(key: string, value: unknown): Thenable<void> { data[key] = value; return Promise.resolve(); },
    keys(): readonly string[] { return Object.keys(data); },
  };
}

afterEach(() => setAccountScope(undefined));

describe('account scope', () => {
  it('未登录沿用原键，登录后加作用域后缀', () => {
    setAccountScope(undefined);
    expect(accountScope()).toBe('local');
    expect(scopedKey('devbelt.ai.chatSessions')).toBe('devbelt.ai.chatSessions');
    setAccountScope('u1');
    expect(scopedKey('devbelt.ai.chatSessions')).toBe('devbelt.ai.chatSessions::u.u1');
    expect(scopedPrefix('devbelt.ai.modelAccess.rec.')).toBe('devbelt.ai.modelAccess.rec.u.u1.');
  });

  it('切换作用域会通知订阅者，同值不重复通知', () => {
    const seen: string[] = [];
    const sub = onAccountScopeChange((scope) => seen.push(scope));
    setAccountScope('u1');
    setAccountScope('u1');
    setAccountScope('u2');
    setAccountScope(undefined);
    expect(seen).toEqual(['u1', 'u2', 'local']);
    sub.dispose();
    setAccountScope('u3');
    expect(seen).toEqual(['u1', 'u2', 'local']);
  });

  it('B1：账号里没有数据时读取旧键并复制一份，原数据保留', async () => {
    const m = memento({ 'devbelt.ai.chatSessions': [{ id: 'a' }] });
    setAccountScope('u1');
    expect(readScoped(m, 'devbelt.ai.chatSessions')).toEqual([{ id: 'a' }]);
    await Promise.resolve();
    expect(m.data['devbelt.ai.chatSessions::u.u1']).toEqual([{ id: 'a' }]);
    expect(m.data['devbelt.ai.chatSessions']).toEqual([{ id: 'a' }]);
  });

  it('账号自己的数据优先于旧键', () => {
    const m = memento({
      'devbelt.ai.chatSessions': [{ id: 'legacy' }],
      'devbelt.ai.chatSessions::u.u1': [{ id: 'mine' }],
    });
    setAccountScope('u1');
    expect(readScoped(m, 'devbelt.ai.chatSessions')).toEqual([{ id: 'mine' }]);
  });

  it('写入只落到当前作用域', async () => {
    const m = memento();
    setAccountScope('u1');
    await writeScoped(m, 'devbelt.esDslQueries', ['x']);
    expect(m.data['devbelt.esDslQueries::u.u1']).toEqual(['x']);
    expect(m.data['devbelt.esDslQueries']).toBeUndefined();
    setAccountScope(undefined);
    expect(readScoped(m, 'devbelt.esDslQueries')).toBeUndefined();
  });
});