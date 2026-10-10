import { describe, expect, it } from 'vitest';
import { deleteByPatternKeys, PatternDeleteError, scanPatternKeys } from '../../src/commands/redisPatternDelete';

type Page = [string, string[]];
/** 假 cluster/standalone client：按游标返回分页，并记录 SCAN/UNLINK（经 sendCommand）。 */
function fakeClient(opts: { cluster: boolean; pageFor: (node: string, cursor: string) => Page | undefined; failOn?: string }) {
  const unlinks: string[][] = [];
  const scans: { node: string; cursor: string }[] = [];
  const scan = (node: string, cursor: string): Page => {
    scans.push({ node, cursor });
    return opts.pageFor(node, cursor) ?? ['0', []];
  };
  const nodeCall = (name: string) => ({
    call: async (cmd: string, cursor: string | number) => (cmd === 'SCAN' ? scan(name, String(cursor)) : 'OK'),
  });
  const client: any = {
    isCluster: opts.cluster,
    nodes: () => [nodeCall('m1'), nodeCall('m2')],
    sendCommand: async (cmd: string, args: (string | number)[] = []) => {
      if (cmd === 'SCAN') return scan('self', String(args[0]));
      if (cmd === 'UNLINK') {
        const keys = args.map(String);
        if (opts.failOn && keys.includes(opts.failOn)) throw new Error(`boom ${opts.failOn}`);
        unlinks.push(keys);
        return keys.length;
      }
      return 'OK';
    },
  };
  return { client, unlinks, scans };
}

describe('redisPatternDelete（cluster 逐 master + 逐键 UNLINK）', () => {
  it('cluster：逐 master SCAN；删除逐键 UNLINK（无多键调用，保 slot 路由/只读切面）', async () => {
    const { client, unlinks, scans } = fakeClient({
      cluster: true,
      pageFor: (node) => (node === 'm1' ? ['0', ['a', 'b']] : node === 'm2' ? ['0', ['c']] : undefined),
    });
    const n = await deleteByPatternKeys(client, 'x*');
    expect(n).toBe(3);
    expect(scans.map((s) => s.node).sort()).toEqual(['m1', 'm2']);
    // 逐键单元素 UNLINK（顺序在分片内不确定，按集合断言）。
    expect(unlinks.flat().sort()).toEqual(['a', 'b', 'c']);
    expect(unlinks.every((u) => u.length === 1)).toBe(true);
  });

  it('cluster：逐 master 多页游标推进到 0（真实分页路径）', async () => {
    const { client, unlinks, scans } = fakeClient({
      cluster: true,
      pageFor: (node, cursor) => {
        if (node === 'm1') return cursor === '0' ? ['5', ['a']] : cursor === '5' ? ['0', ['b']] : undefined;
        return ['0', []]; // m2 空
      },
    });
    const n = await deleteByPatternKeys(client, 'x*');
    expect(n).toBe(2);
    // m1 两次 SCAN（游标 '0' → '5'），m2 一次。
    expect(scans.filter((s) => s.node === 'm1').map((s) => s.cursor)).toEqual(['0', '5']);
    expect(unlinks.flat().sort()).toEqual(['a', 'b']);
  });

  it('standalone：单 client 多页 SCAN；删除多键一批 UNLINK', async () => {
    const { client, unlinks, scans } = fakeClient({
      cluster: false,
      pageFor: (_node, cursor) => (cursor === '0' ? ['7', ['a', 'b']] : cursor === '7' ? ['0', ['c']] : undefined),
    });
    const n = await deleteByPatternKeys(client, 'x*');
    expect(n).toBe(3);
    expect(scans.map((s) => s.node)).toEqual(['self', 'self']);
    expect(unlinks).toEqual([['a', 'b'], ['c']]);
  });

  it('中途失败：抛 PatternDeleteError 且带已删除数（避免无痕迹部分删除）', async () => {
    const { client } = fakeClient({
      cluster: true,
      pageFor: (node) => (node === 'm1' ? ['0', ['a']] : node === 'm2' ? ['0', ['fail']] : undefined),
      failOn: 'fail',
    });
    await expect(deleteByPatternKeys(client, 'x*')).rejects.toMatchObject({ name: 'PatternDeleteError', deleted: 1 });
    await expect(deleteByPatternKeys(client, 'x*')).rejects.toBeInstanceOf(PatternDeleteError);
  });

  it('scanPatternKeys：cluster 计数逐 master（不删除）', async () => {
    const { client, unlinks, scans } = fakeClient({
      cluster: true,
      pageFor: (node) => (node === 'm1' ? ['0', ['a']] : node === 'm2' ? ['0', ['b', 'c']] : undefined),
    });
    const n = await scanPatternKeys(client, 'x*');
    expect(n).toBe(3);
    expect(unlinks).toEqual([]);
    expect(scans.length).toBe(2);
  });
});

describe('redisPatternDelete 分页加锁（D11）', () => {
  it('standalone：每页一次 withLock；锁内先 select，SCAN/UNLINK 均在锁内', async () => {
    const { client } = fakeClient({
      cluster: false,
      pageFor: (_n, cursor) => (cursor === '0' ? ['7', ['a', 'b']] : cursor === '7' ? ['0', ['c']] : undefined),
    });
    const order: string[] = [];
    const unlinkLocked: boolean[] = [];
    let active = 0;
    const orig = client.sendCommand;
    client.sendCommand = async (cmd: string, args: (string | number)[] = []) => {
      if (cmd === 'UNLINK') unlinkLocked.push(active > 0);
      return orig(cmd, args);
    };
    const n = await deleteByPatternKeys(client, 'x*', {
      withLock: async <T>(fn: () => Promise<T>): Promise<T> => {
        active += 1;
        order.push('lock');
        try { return await fn(); } finally { active -= 1; }
      },
      select: async () => { order.push('select'); },
    });
    expect(n).toBe(3);
    // 两页 → 两次加锁；每页锁内第一动作是 SELECT 归一（锁 → select → SCAN/UNLINK）。
    expect(order.filter((x) => x === 'lock')).toHaveLength(2);
    expect(order.filter((x) => x === 'select')).toHaveLength(2);
    expect(order.slice(0, 2)).toEqual(['lock', 'select']);
    expect(unlinkLocked).toEqual([true, true]);
  });

  it('cluster：逐 master 逐页加锁；调用方不注入 select（无逻辑库）', async () => {
    const { client } = fakeClient({
      cluster: true,
      pageFor: (node) => (node === 'm1' ? ['0', ['a']] : node === 'm2' ? ['0', []] : undefined),
    });
    let locks = 0;
    await deleteByPatternKeys(client, 'x*', {
      withLock: async <T>(fn: () => Promise<T>): Promise<T> => { locks += 1; return fn(); },
    });
    expect(locks).toBe(2);
  });

  it('无 hooks：行为与旧调用一致（整段调用方持锁）', async () => {
    const { client, unlinks } = fakeClient({
      cluster: false,
      pageFor: (_n, cursor) => (cursor === '0' ? ['0', ['a']] : undefined),
    });
    const n = await deleteByPatternKeys(client, 'x*');
    expect(n).toBe(1);
    expect(unlinks).toEqual([['a']]);
  });

  it('加锁路径失败语义不变：PatternDeleteError 携带已删除数', async () => {
    const { client } = fakeClient({
      cluster: true,
      pageFor: (node) => (node === 'm1' ? ['0', ['a']] : node === 'm2' ? ['0', ['fail']] : undefined),
      failOn: 'fail',
    });
    await expect(deleteByPatternKeys(client, 'x*', {
      withLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    })).rejects.toMatchObject({ name: 'PatternDeleteError', deleted: 1 });
  });
});