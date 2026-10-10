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
  redisHScanBuffer,
  redisHDelBuffer,
  redisHSetBuffer,
  isValidUtf8,
  redisDatabases,
  redisKeyspace,
  redisLIndexBuffer,
  redisLRemBuffer,
  redisLRangeBuffer,
  redisLSetBuffer,
  redisMemoryUsage,
  redisScan,
  redisSelect,
  redisSetBuffer,
  redisSRemBuffer,
  redisSScanBuffer,
  redisTtl,
  redisType,
  redisXRangeBuffer,
  redisZRange,
  redisZRangeBuffer,
  redisZRemBuffer,
  redisZAddBuffer,
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

describe('redisDatabases（DB 列表来源，best-effort）', () => {
  it('解析 CONFIG GET databases', async () => {
    const src = new FakeSource();
    src.replies.set('CONFIG', ['databases', '16']);
    expect(await redisDatabases(src)).toBe(16);
    expect(src.calls[0].name).toBe('CONFIG');
    expect(src.calls[0].args).toEqual(['GET', 'databases']);
  });

  it('畸形回复（非数组/非数字/<=0）降级为 null', async () => {
    const src = new FakeSource();
    src.replies.set('CONFIG', 'OK');
    expect(await redisDatabases(src)).toBeNull();
    src.replies.set('CONFIG', ['databases', 'abc']);
    expect(await redisDatabases(src)).toBeNull();
    src.replies.set('CONFIG', ['databases', '0']);
    expect(await redisDatabases(src)).toBeNull();
  });

  it('CONFIG 被禁用（命令失败）时降级为 null，不抛', async () => {
    const src = new FakeSource();
    src.failOn.add('CONFIG');
    expect(await redisDatabases(src)).toBeNull();
  });
});

describe('字节级集合 ops（3C-1）', () => {
  it('HSCAN buffer：解析 Buffer 游标/字段/值', async () => {
    const src = new BufferSource();
    src.reply = [Buffer.from('5'), [Buffer.from([0xff, 0x61]), Buffer.from('v')]];
    const page = await redisHScanBuffer(src, 'h', 0, { count: 10 });
    expect(page.cursor).toBe('5');
    expect(page.entries[0][0].equals(Buffer.from([0xff, 0x61]))).toBe(true);
    expect(page.entries[0][1].toString()).toBe('v');
    expect(src.calls[0]).toMatchObject({ name: 'HSCAN', buffer: true, args: ['h', '0', 'COUNT', 10] });
  });

  it('无 buffer 源时降级：字符串结果转 Buffer', async () => {
    const src = new FakeSource();
    src.replies.set('HSCAN', ['0', ['f', 'v']]);
    const page = await redisHScanBuffer(src, 'h', 0);
    expect(page.entries).toEqual([[Buffer.from('f'), Buffer.from('v')]]);
  });

  it('SSCAN / LRANGE / ZRANGE buffer 解析', async () => {
    const src = new BufferSource();
    src.reply = [Buffer.from('0'), [Buffer.from('m')]];
    expect((await redisSScanBuffer(src, 's', 0)).keys[0].toString()).toBe('m');

    src.reply = [Buffer.from([0x00]), Buffer.from('x')];
    expect((await redisLRangeBuffer(src, 'l', 0, 1))[0].equals(Buffer.from([0x00]))).toBe(true);

    src.reply = [Buffer.from('m1'), Buffer.from('1.5'), Buffer.from('m2'), Buffer.from('2')];
    expect(await redisZRangeBuffer(src, 'z', 0, 1)).toEqual([
      { member: Buffer.from('m1'), score: '1.5' },
      { member: Buffer.from('m2'), score: '2' },
    ]);
  });

  it('XRANGE buffer：嵌套 field/value 保留原始字节', async () => {
    const src = new BufferSource();
    src.reply = [[Buffer.from('1-0'), [Buffer.from([0xff]), Buffer.from('v')]]];
    const entries = await redisXRangeBuffer(src, 'st', '-', '+', 100);
    expect(entries[0].id).toBe('1-0');
    expect(entries[0].fields[0][0].equals(Buffer.from([0xff]))).toBe(true);
    expect(src.calls[0]).toMatchObject({ name: 'XRANGE', buffer: true });
  });

  it('LINDEX buffer：null 与原始字节', async () => {
    const src = new BufferSource();
    src.reply = null;
    expect(await redisLIndexBuffer(src, 'l', 0)).toBeNull();
    src.reply = Buffer.from([0x00, 0xff]);
    expect((await redisLIndexBuffer(src, 'l', 0))!.equals(Buffer.from([0x00, 0xff]))).toBe(true);
  });

  it('删除/回写 ops 传 Buffer 参数；无 buffer 源降级为字符串', async () => {
    const src = new BufferSource();
    src.reply = 1;
    expect(await redisHDelBuffer(src, 'h', [Buffer.from([0xff])])).toBe(1);
    expect(Buffer.isBuffer(src.calls[0].args[1])).toBe(true);
    expect(await redisSRemBuffer(src, 's', [Buffer.from('m')])).toBe(1);
    expect(await redisZRemBuffer(src, 'z', [Buffer.from('m')])).toBe(1);
    expect(await redisLRemBuffer(src, 'l', 1, Buffer.from([0x00]))).toBe(1);
    expect(await redisLSetBuffer(src, 'l', 0, Buffer.from([0x00]))).toBeUndefined();

    const str = new FakeSource();
    str.replies.set('HDEL', 2);
    expect(await redisHDelBuffer(str, 'h', [Buffer.from('f')])).toBe(2);
    expect(str.calls[0].args).toEqual(['h', 'f']);
  });

  it('写入 ops：HSET/ZADD 传 Buffer 参数；无 buffer 源降级字符串', async () => {
    const src = new BufferSource();
    src.reply = 1;
    await redisHSetBuffer(src, 'h', Buffer.from([0xff]), Buffer.from([0x00]));
    expect(Buffer.isBuffer(src.calls[0].args[1])).toBe(true);
    expect(Buffer.isBuffer(src.calls[0].args[2])).toBe(true);
    await redisZAddBuffer(src, 'z', '1.5', Buffer.from([0xfe]));
    expect(Buffer.isBuffer(src.calls[1].args[2])).toBe(true);

    const str = new FakeSource();
    await redisHSetBuffer(str, 'h', Buffer.from('f'), Buffer.from('v'));
    expect(str.calls[0].args).toEqual(['h', 'f', 'v']);
    await redisZAddBuffer(str, 'z', 2, Buffer.from('m'));
    expect(str.calls[1].args).toEqual(['z', '2', 'm']);
  });
});
