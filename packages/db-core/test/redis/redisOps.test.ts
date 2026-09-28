import { describe, expect, it } from 'vitest';
import {
  normalizeHashReply,
  parseKeyspace,
  redisDel,
  redisExists,
  redisExpire,
  redisGet,
  redisGetBuffer,
  redisHGetAll,
  redisHScan,
  isValidUtf8,
  redisKeyspace,
  redisMemoryUsage,
  redisScan,
  redisSelect,
  redisSetBuffer,
  redisTtl,
  redisType,
  redisZRange,
  type RedisCommandSource,
} from '../../src/redis/redisOps';

class FakeSource implements RedisCommandSource {
  readonly calls: { name: string; args: (string | number)[] }[] = [];
  readonly replies = new Map<string, unknown>();
  failOn = new Set<string>();

  async sendCommand(name: string, args: (string | number)[] = []): Promise<unknown> {
    this.calls.push({ name: name.toUpperCase(), args });
    if (this.failOn.has(name.toUpperCase())) throw new Error('ERR unknown command');
    return this.replies.has(name.toUpperCase()) ? this.replies.get(name.toUpperCase()) : 'OK';
  }
}

/** 支持字节级命令的假源：reply 原样返回（模拟 ioredis replyEncoding:null）。 */
class BufferSource implements RedisCommandSource {
  readonly calls: { name: string; args: (string | number | Buffer)[]; buffer: boolean }[] = [];
  reply: unknown = null;

  async sendCommand(name: string, args: (string | number)[] = []): Promise<unknown> {
    this.calls.push({ name: name.toUpperCase(), args, buffer: false });
    return 'OK';
  }

  async sendCommandBuffer(name: string, args: (string | number | Buffer)[] = []): Promise<unknown> {
    this.calls.push({ name: name.toUpperCase(), args, buffer: true });
    return this.reply;
  }
}

describe('redisOps：命令与归一化', () => {
  it('TYPE 小写化；SCAN 解析 cursor/keys', async () => {
    const src = new FakeSource();
    src.replies.set('TYPE', 'hash');
    src.replies.set('SCAN', ['17', ['a', 'b']]);
    expect(await redisType(src, 'k')).toBe('hash');
    expect(await redisScan(src, 0, { match: 'foo:*', count: 100 })).toEqual({ cursor: '17', keys: ['a', 'b'] });
    expect(src.calls[1]).toEqual({ name: 'SCAN', args: ['0', 'MATCH', 'foo:*', 'COUNT', 100] });
  });

  it('redisSelect 发小写 select（ioredis 仅小写才记录当前库）', async () => {
    const names: string[] = [];
    const raw = { sendCommand: async (name: string) => { names.push(name); return 'OK'; } };
    await redisSelect(raw as never, 2);
    expect(names).toEqual(['select']);
  });

  it('SELECT/DEL 参数；空 DEL 不发包', async () => {
    const src = new FakeSource();
    await redisSelect(src, 3);
    expect(src.calls[0]).toEqual({ name: 'SELECT', args: [3] }); // FakeSource 记录时统一大写
    expect(await redisDel(src, ['a', 'b'])).toBe(0); // 'OK' -> Number('OK')=NaN -> 0
    expect(src.calls[1]).toEqual({ name: 'DEL', args: ['a', 'b'] });
    const before = src.calls.length;
    await redisDel(src, []);
    expect(src.calls.length).toBe(before);
  });

  it('TTL/EXPIRE/PERSIST 数值归一化', async () => {
    const src = new FakeSource();
    src.replies.set('TTL', 120);
    src.replies.set('EXPIRE', 1);
    src.replies.set('PERSIST', 0);
    expect(await redisTtl(src, 'k')).toBe(120);
    expect(await redisExpire(src, 'k', 60)).toBe(true);
    expect(src.calls.find((c) => c.name === 'EXPIRE')!.args).toEqual(['k', 60]);
  });

  it('hgetall 三种回复形态归一化', () => {
    expect(normalizeHashReply(['f', 'v', 'g', 'w'])).toEqual([['f', 'v'], ['g', 'w']]);
    expect(normalizeHashReply([['f', 'v']])).toEqual([['f', 'v']]);
    expect(normalizeHashReply({ f: 'v' })).toEqual([['f', 'v']]);
  });

  it('HGETALL / HSCAN 走 pairs', async () => {
    const src = new FakeSource();
    src.replies.set('HGETALL', ['f', 'v']);
    src.replies.set('HSCAN', ['0', ['a', '1', 'b', '2']]);
    expect(await redisHGetAll(src, 'h')).toEqual([['f', 'v']]);
    expect(await redisHScan(src, 'h', 0)).toEqual({ cursor: '0', entries: [['a', '1'], ['b', '2']] });
  });

  it('ZRANGE WITHSCORES 走 pairs；REV 加参数', async () => {
    const src = new FakeSource();
    src.replies.set('ZRANGE', ['m1', '1', 'm2', '2']);
    expect(await redisZRange(src, 'z', 0, -1, { rev: true })).toEqual([['m1', '1'], ['m2', '2']]);
    expect(src.calls[0].args).toEqual(['z', 0, -1, 'REV', 'WITHSCORES']);
  });

  it('GET 缺失返回空串', async () => {
    const src = new FakeSource();
    src.replies.set('GET', null);
    expect(await redisGet(src, 'k')).toBe('');
  });

  it('redisGetBuffer：有 sendCommandBuffer 时返回原始字节（二进制安全）', async () => {
    const src = new BufferSource();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    src.reply = bytes;
    expect(await redisGetBuffer(src, 'k')).toEqual(bytes);
    expect(src.calls[0]).toEqual({ name: 'GET', args: ['k'], buffer: true });
  });

  it('redisGetBuffer：缺失返回 null；源不支持时按 UTF-8 退化', async () => {
    const bufSrc = new BufferSource();
    bufSrc.reply = null;
    expect(await redisGetBuffer(bufSrc, 'k')).toBeNull();
    const plain = new FakeSource();
    plain.replies.set('GET', 'héllo');
    expect(await redisGetBuffer(plain, 'k')).toEqual(Buffer.from('héllo', 'utf8'));
  });

  it('redisSetBuffer：以原始 Buffer 提交 SET', async () => {
    const src = new BufferSource();
    const bytes = Buffer.from([0x00, 0xfe]);
    await redisSetBuffer(src, 'k', bytes);
    expect(src.calls[0].name).toBe('SET');
    expect(src.calls[0].args[0]).toBe('k');
    expect(src.calls[0].args[1]).toEqual(bytes);
  });

  it('isValidUtf8：合法 UTF-8 为 true，孤立 0xff 为 false', () => {
    expect(isValidUtf8(Buffer.from('中文abc', 'utf8'))).toBe(true);
    expect(isValidUtf8(Buffer.from([0xff]))).toBe(false);
  });

  it('EXISTS 布尔归一化', async () => {
    const src = new FakeSource();
    src.replies.set('EXISTS', 1);
    expect(await redisExists(src, 'k')).toBe(true);
    src.replies.set('EXISTS', 0);
    expect(await redisExists(src, 'k')).toBe(false);
  });

  it('MEMORY USAGE 不可用时返回 null（不门禁）', async () => {
    const src = new FakeSource();
    src.failOn.add('MEMORY');
    expect(await redisMemoryUsage(src, 'k')).toBeNull();
    src.failOn.delete('MEMORY');
    src.replies.set('MEMORY', 2048);
    expect(await redisMemoryUsage(src, 'k')).toBe(2048);
  });
});

describe('parseKeyspace / redisKeyspace', () => {
  it('解析 dbN 行并按 index 排序', () => {
    const info = '# Keyspace\ndb1:keys=5,expires=1,avg_ttl=0\ndb0:keys=2,expires=0,avg_ttl=0\n';
    expect(parseKeyspace(info)).toEqual([
      { index: 0, keys: 2, expires: 0, avgTtl: 0 },
      { index: 1, keys: 5, expires: 1, avgTtl: 0 },
    ]);
  });

  it('空 keyspace 返回 []', () => {
    expect(parseKeyspace('# Keyspace\n')).toEqual([]);
  });

  it('redisKeyspace 发 INFO keyspace', async () => {
    const src = new FakeSource();
    src.replies.set('INFO', '# Keyspace\ndb0:keys=1,expires=0,avg_ttl=0\n');
    expect(await redisKeyspace(src)).toEqual([{ index: 0, keys: 1, expires: 0, avgTtl: 0 }]);
    expect(src.calls[0].args).toEqual(['keyspace']);
  });
});
