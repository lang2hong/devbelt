import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisClient, RedisReadOnlyError } from '../../src/redis/redisClient';
import {
  redisDbsize,
  redisDel,
  redisExpire,
  redisGet,
  redisHGetAll,
  redisHSet,
  redisKeyspace,
  redisLRange,
  redisLPush,
  redisPersist,
  redisSAdd,
  redisScan,
  redisSelect,
  redisSMembers,
  redisSet,
  redisStrlen,
  redisTtl,
  redisType,
  redisZAdd,
  redisZRange,
} from '../../src/redis/redisOps';

/**
 * 真实 Redis 集成测试（P7 S1–S3 行为验证）。
 *
 * 由 `DEVBELT_DB_TEST_REDIS_URL` / `..._AUTH_URL` 门禁：未设置时整体 skip，
 * 本地无 Redis 也能 `pnpm test` 通过；CI `integration` job 用 service container 打开。
 * 覆盖 reviewer 关心的「真实回包形状」：SCAN 游标、INFO keyspace、SELECT、SLOWLOG、
 * HGETALL 形状、ZRANGE WITHSCORES 的 stringNumbers 行为，以及只读切面。
 */

function parseUrl(raw: string): { host: string; port: number; username?: string; password?: string; db?: number } {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
  };
}

function makeClient(raw: string, readOnly = false): RedisClient {
  const { host, port, username, password, db } = parseUrl(raw);
  return new RedisClient({ host, port, username, password, db, readOnly, connectTimeout: 10_000 });
}

const REDIS_URL = process.env.DEVBELT_DB_TEST_REDIS_URL;
const REDIS_AUTH_URL = process.env.DEVBELT_DB_TEST_REDIS_AUTH_URL;

describe.skipIf(!REDIS_URL)('Redis 真实实例（standalone）', () => {
  let client: RedisClient;
  const prefix = `devbelt:it:${Date.now()}:`;
  const created: string[] = [];

  beforeAll(async () => {
    client = makeClient(REDIS_URL!);
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      try { if (created.length) await redisDel(client, created); } catch { /* best effort */ }
      await client.close();
    }
  });

  it('connect + PING', async () => {
    expect(await client.ping()).toBe('PONG');
  });

  it('string 往返：SET/GET/TYPE/STRLEN/TTL/EXPIRE/PERSIST/DEL', async () => {
    const key = `${prefix}str`;
    created.push(key);
    await redisSet(client, key, 'hello');
    expect(await redisGet(client, key)).toBe('hello');
    expect(await redisType(client, key)).toBe('string');
    expect(await redisStrlen(client, key)).toBe(5);
    expect(await redisTtl(client, key)).toBe(-1);
    expect(await redisExpire(client, key, 100)).toBe(true);
    expect(await redisTtl(client, key)).toBeGreaterThan(0);
    expect(await redisPersist(client, key)).toBe(true);
    expect(await redisTtl(client, key)).toBe(-1);
    expect(await redisDel(client, [key])).toBe(1);
    expect(await redisGet(client, key)).toBe('');
  });

  it('SCAN 真实回包：游标为字符串，keys 命中', async () => {
    const keys = [`${prefix}s1`, `${prefix}s2`, `${prefix}s3`];
    for (const k of keys) { await redisSet(client, k, 'v'); created.push(k); }
    let cursor = '0';
    const found: string[] = [];
    for (let i = 0; i < 20; i++) {
      const page = await redisScan(client, cursor, { match: `${prefix}s*`, count: 10 });
      expect(typeof page.cursor).toBe('string');
      found.push(...page.keys);
      cursor = page.cursor;
      if (cursor === '0') break;
    }
    for (const k of keys) expect(found).toContain(k);
  });

  it('INFO keyspace 解析出 db0', async () => {
    const stats = await redisKeyspace(client);
    const db0 = stats.find((s) => s.index === 0);
    expect(db0).toBeTruthy();
    expect(db0!.keys).toBeGreaterThan(0);
  });

  it('SELECT 切换库：数据隔离，可切回', async () => {
    const k0 = `${prefix}db0`;
    await redisSet(client, k0, 'in0');
    created.push(k0);
    await redisSelect(client, 3);
    expect(await redisGet(client, k0)).toBe('');
    const k3 = `${prefix}db3`;
    await redisSet(client, k3, 'in3');
    expect(await redisGet(client, k3)).toBe('in3');
    expect(await redisDel(client, [k3])).toBe(1);
    await redisSelect(client, 0);
    expect(await redisGet(client, k0)).toBe('in0');
  });

  it('hash：HSET/HGETALL 归一化为 pairs', async () => {
    const key = `${prefix}hash`;
    created.push(key);
    await redisHSet(client, key, 'f1', 'v1');
    await redisHSet(client, key, 'f2', 'v2');
    const entries = await redisHGetAll(client, key);
    expect(entries.sort()).toEqual([['f1', 'v1'], ['f2', 'v2']]);
  });

  it('list：RPUSH/LRANGE', async () => {
    const key = `${prefix}list`;
    created.push(key);
    await redisLPush(client, key, ['a']);
    await redisLPush(client, key, ['b']);
    expect(await redisLRange(client, key, 0, -1)).toEqual(['b', 'a']);
  });

  it('set：SADD/SMEMBERS', async () => {
    const key = `${prefix}set`;
    created.push(key);
    await redisSAdd(client, key, ['m1', 'm2']);
    expect((await redisSMembers(client, key)).sort()).toEqual(['m1', 'm2']);
  });

  it('zset：ZADD/ZRANGE WITHSCORES（stringNumbers 下 score 为字符串）', async () => {
    const key = `${prefix}zset`;
    created.push(key);
    await redisZAdd(client, key, 2, 'two');
    await redisZAdd(client, key, 1, 'one');
    const items = await redisZRange(client, key, 0, -1);
    expect(items).toEqual([['one', '1'], ['two', '2']]);
    for (const [, score] of items) expect(typeof score).toBe('string');
  });

  it('SLOWLOG GET 回包为数组（结构可解析）', async () => {
    const raw = await client.sendCommand('SLOWLOG', ['GET', '10']);
    expect(Array.isArray(raw)).toBe(true);
  });

  it('DBSIZE 为正整数', async () => {
    expect(await redisDbsize(client)).toBeGreaterThan(0);
  });

  it('只读客户端：写命令被拦，读命令放行', async () => {
    const ro = makeClient(REDIS_URL!, true);
    await ro.connect();
    try {
      await expect(ro.sendCommand('SET', [`${prefix}ro`, 'x'])).rejects.toBeInstanceOf(RedisReadOnlyError);
      await expect(ro.sendCommand('PING', [])).resolves.toBe('PONG');
    } finally {
      await ro.close();
    }
  });
});

describe.skipIf(!REDIS_AUTH_URL)('Redis 真实实例（requirepass）', () => {
  it('正确密码可连并 PING', async () => {
    const client = makeClient(REDIS_AUTH_URL!);
    await client.connect();
    try {
      expect(await client.ping()).toBe('PONG');
    } finally {
      await client.close();
    }
  });

  it('错误密码连接失败', async () => {
    const { host, port, username } = parseUrl(REDIS_AUTH_URL!);
    const bad = new RedisClient({ host, port, username, password: 'definitely-wrong', connectTimeout: 10_000, maxRetryTimes: 0 });
    await expect(bad.connect()).rejects.toBeTruthy();
    await bad.close();
  });
});
