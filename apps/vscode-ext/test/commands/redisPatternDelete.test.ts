import { describe, expect, it } from 'vitest';
import { deleteByPatternKeys, scanPatternKeys } from '../../src/commands/redisPatternDelete';

/** 记录 sendCommand（经 redisUnlink）的假 cluster/standalone client。 */
function fakeClient(opts: { cluster: boolean; pagesPerNode?: Record<string, unknown[]> }) {
  const unlinks: string[][] = [];
  const nodeScans: { node: string; cursor: string }[] = [];
  const pages = opts.pagesPerNode ?? {};
  const nodeCall = (name: string) => ({
    call: async (cmd: string, cursor: string | number) => {
      if (cmd === 'SCAN') {
        nodeScans.push({ node: name, cursor: String(cursor) });
        // 首页返回数据 + 游标 0（单页）
        return ['0', pages[name] ?? []];
      }
      return 'OK';
    },
  });
  const client: any = {
    isCluster: opts.cluster,
    nodes: () => [nodeCall('m1'), nodeCall('m2')],
    sendCommand: async (cmd: string, args: (string | number)[] = []) => {
      if (cmd === 'UNLINK') unlinks.push(args.map(String));
      if (cmd === 'SCAN') {
        nodeScans.push({ node: 'self', cursor: String(args[0]) });
        return ['0', pages.self ?? []];
      }
      return 'OK';
    },
  };
  return { client, unlinks, nodeScans };
}

describe('redisPatternDelete（cluster 逐 master + 逐键 UNLINK）', () => {
  it('cluster：逐 master SCAN；删除逐键 UNLINK（无多键调用，保 slot 路由/只读切面）', async () => {
    const { client, unlinks, nodeScans } = fakeClient({
      cluster: true,
      pagesPerNode: { m1: ['a', 'b'], m2: ['c'] },
    });
    const n = await deleteByPatternKeys(client, 'x*');
    expect(n).toBe(3);
    expect(nodeScans.map((s) => s.node).sort()).toEqual(['m1', 'm2']);
    // 逐键单元素 UNLINK，且均经 sendCommand（非节点 call）。
    expect(unlinks).toEqual([['a'], ['b'], ['c']]);
  });

  it('standalone：单 client SCAN；删除多键一批 UNLINK', async () => {
    const { client, unlinks, nodeScans } = fakeClient({ cluster: false, pagesPerNode: { self: ['a', 'b', 'c'] } });
    const n = await deleteByPatternKeys(client, 'x*');
    expect(n).toBe(3);
    expect(nodeScans.map((s) => s.node)).toEqual(['self']);
    expect(unlinks).toEqual([['a', 'b', 'c']]);
  });

  it('scanPatternKeys：cluster 计数逐 master（不删除）', async () => {
    const { client, unlinks, nodeScans } = fakeClient({ cluster: true, pagesPerNode: { m1: ['a'], m2: ['b', 'c'] } });
    const n = await scanPatternKeys(client, 'x*');
    expect(n).toBe(3);
    expect(unlinks).toEqual([]);
    expect(nodeScans.length).toBe(2);
  });
});