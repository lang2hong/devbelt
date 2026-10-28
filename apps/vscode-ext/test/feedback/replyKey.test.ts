import { describe, expect, it, vi } from 'vitest';
import { getOrCreateReplyKey, readReplyKey, REPLY_KEY_SECRET, type SecretStoreLike } from '../../src/feedback/replyKey';

vi.mock('vscode', () => ({}));

const { countUnread } = await import('../../src/feedback/feedbackView');

function memorySecrets(initial: Record<string, string> = {}): SecretStoreLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => { data.set(k, v); },
  };
}

describe('replyKey', () => {
  it('首次生成 43 字符 base64url 并持久化，之后复用', async () => {
    const s = memorySecrets();
    const first = await getOrCreateReplyKey(s);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.data.get(REPLY_KEY_SECRET)).toBe(first);
    expect(await getOrCreateReplyKey(s)).toBe(first);
  });

  it('readReplyKey 不生成新 key', async () => {
    const s = memorySecrets();
    expect(await readReplyKey(s)).toBeUndefined();
    expect(s.data.size).toBe(0);
  });

  it('存量值格式非法时视为不存在并重新生成', async () => {
    const s = memorySecrets({ [REPLY_KEY_SECRET]: 'garbage' });
    expect(await readReplyKey(s)).toBeUndefined();
    const k = await getOrCreateReplyKey(s);
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('SecretStorage 不可用时返回 undefined，不抛错', async () => {
    const broken: SecretStoreLike = {
      get: async () => { throw new Error('no keyring'); },
      store: async () => { throw new Error('no keyring'); },
    };
    await expect(readReplyKey(broken)).resolves.toBeUndefined();
    await expect(getOrCreateReplyKey(broken)).resolves.toBeUndefined();
  });

  it('并发窗口覆盖写入时以最终落盘值为准', async () => {
    const s = memorySecrets();
    const winner = 'W'.repeat(43);
    s.store = async (k) => { s.data.set(k, winner); };
    expect(await getOrCreateReplyKey(s)).toBe(winner);
  });
});

describe('countUnread', () => {
  const items = [
    { id: '1', category: 'bug' as const, content: 'a', status: 'triaged' as const, createTime: '', replies: [
      { id: '5', body: 'x', createTime: '' },
      { id: '12', body: 'y', createTime: '' },
    ] },
    { id: '2', category: 'other' as const, content: 'b', status: 'new' as const, createTime: '', replies: [] },
  ];

  it('按数值比较回复 id（非字典序）', () => {
    expect(countUnread(items, 0n)).toBe(2);
    expect(countUnread(items, 5n)).toBe(1);
    expect(countUnread(items, 9n)).toBe(1);
    expect(countUnread(items, 12n)).toBe(0);
  });
});
