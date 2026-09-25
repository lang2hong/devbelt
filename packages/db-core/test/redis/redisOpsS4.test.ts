import { describe, expect, it } from 'vitest';
import {
  parseInfoEntries,
  parseStreamEntries,
  redisDbsizeOnNode,
  redisKeyspaceOnNode,
  redisScanOnNode,
  redisSlowlogOnNode,
  redisXAdd,
  redisXGroupCreate,
  redisXRange,
  parseXPending,
  isValidStreamId,
  compareStreamId,
  type RedisCommandSource,
  type RedisNodeSource,
} from '../../src/redis/redisOps';

class FakeNode implements RedisNodeSource {
  readonly calls: { cmd: string; args: (string | number)[] }[] = [];
  reply: unknown = 'OK';
  async call(command: string, ...args: (string | number)[]): Promise<unknown> {
    this.calls.push({ cmd: command, args });
    return this.reply;
  }
}

class FakeSrc implements RedisCommandSource {
  readonly calls: { name: string; args: (string | number)[] }[] = [];
  reply: unknown = 'OK';
  async sendCommand(name: string, args: (string | number)[] = []): Promise<unknown> {
    this.calls.push({ name: name.toUpperCase(), args });
    return this.reply;
  }
}

describe('redisOps 集群节点 ops（S4）', () => {
  it('redisScanOnNode 发 SCAN 并解析游标/keys', async () => {
    const node = new FakeNode();
    node.reply = ['5', ['a', 'b']];
    expect(await redisScanOnNode(node, 0, { match: 'x:*', count: 10 })).toEqual({ cursor: '5', keys: ['a', 'b'] });
    expect(node.calls[0]).toEqual({ cmd: 'SCAN', args: ['0', 'MATCH', 'x:*', 'COUNT', 10] });
  });

  it('redisKeyspaceOnNode 解析 dbN', async () => {
    const node = new FakeNode();
    node.reply = '# Keyspace\ndb0:keys=3,expires=0,avg_ttl=0\n';
    expect(await redisKeyspaceOnNode(node)).toEqual([{ index: 0, keys: 3, expires: 0, avgTtl: 0 }]);
    expect(node.calls[0]).toEqual({ cmd: 'INFO', args: ['keyspace'] });
  });

  it('redisDbsizeOnNode / redisSlowlogOnNode', async () => {
    const node = new FakeNode();
    node.reply = 7;
    expect(await redisDbsizeOnNode(node)).toBe(7);
    node.reply = [[1, 2, 3, ['SET'], 'c', 'n']];
    expect((await redisSlowlogOnNode(node, 5) as unknown[]).length).toBe(1);
    expect(node.calls[1]).toEqual({ cmd: 'SLOWLOG', args: ['GET', 5] });
  });
});

describe('redisOps Stream（S4）', () => {
  it('XRANGE 归一化为 {id, fields}', async () => {
    const src = new FakeSrc();
    src.reply = [['1-0', ['f1', 'v1', 'f2', 'v2']], ['2-0', ['f', 'v']]];
    expect(await redisXRange(src, 's', '-', '+', 10)).toEqual([
      { id: '1-0', fields: [['f1', 'v1'], ['f2', 'v2']] },
      { id: '2-0', fields: [['f', 'v']] },
    ]);
    expect(src.calls[0]).toEqual({ name: 'XRANGE', args: ['s', '-', '+', 'COUNT', 10] });
  });

  it('parseStreamEntries 容错非数组', () => {
    expect(parseStreamEntries(null)).toEqual([]);
    expect(parseStreamEntries([42])).toEqual([]);
  });

  it('XADD 展开字段；XGROUP CREATE 带 MKSTREAM', async () => {
    const src = new FakeSrc();
    src.reply = '1-0';
    expect(await redisXAdd(src, 's', [['a', '1'], ['b', '2']], '*')).toBe('1-0');
    expect(src.calls[0]).toEqual({ name: 'XADD', args: ['s', '*', 'a', '1', 'b', '2'] });
    await redisXGroupCreate(src, 's', 'g', '$', true);
    expect(src.calls[1]).toEqual({ name: 'XGROUP', args: ['CREATE', 's', 'g', '$', 'MKSTREAM'] });
  });

  it('parseInfoEntries 扁平 → 对象', () => {
    expect(parseInfoEntries([['name', 'g', 'consumers', '2']])).toEqual([{ name: 'g', consumers: '2' }]);
  });
});

describe('redisOps Stream XPENDING / ID 校验（S4）', () => {
  it('parseXPending 归一化摘要；空回复安全', () => {
    expect(parseXPending([2, '1-0', '3-0', [['c1', '2']]])).toEqual({
      count: 2, minId: '1-0', maxId: '3-0', consumers: [['c1', '2']],
    });
    expect(parseXPending(null)).toEqual({ count: 0, minId: '', maxId: '', consumers: [] });
    expect(parseXPending([0, null, null, []])).toEqual({ count: 0, minId: '', maxId: '', consumers: [] });
  });

  it('isValidStreamId：* 或 <ms>[-<seq>]', () => {
    expect(isValidStreamId('*')).toBe(true);
    expect(isValidStreamId('1700000000000')).toBe(true);
    expect(isValidStreamId('1700000000000-3')).toBe(true);
    expect(isValidStreamId('abc')).toBe(false);
    expect(isValidStreamId('1-')).toBe(false);
    expect(isValidStreamId('-1')).toBe(false);
  });

  it('compareStreamId 按 ms 再 seq', () => {
    expect(compareStreamId('2-0', '1-9')).toBe(1);
    expect(compareStreamId('1-2', '1-10')).toBe(-1);
    expect(compareStreamId('1-0', '1')).toBe(0);
    expect(compareStreamId('1', '1-0')).toBe(0);
  });
});
