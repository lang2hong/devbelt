/**
 * Redis 「按 pattern 全量扫描 / 删除」（C-3）。
 *
 * 纯逻辑，依赖最小 client 接口，便于单测。**cluster 必须逐 master**：`SCAN` 无 key，
 * ioredis 只会路由到单个节点；删除时多键跨 slot 会 CROSSSLOT。
 *
 * 删除一律经 client 的 `sendCommand`（即 `redisUnlink`）：cluster 逐键（按 slot 路由 +
 * 仍经只读切面），并按分片并发以缩短共享连接的锁占用；standalone 可多键一批。
 */
import { redisScan, redisScanOnNode, redisUnlink } from '@devbelt/db-core';

export interface RedisPatternClient {
  isCluster: boolean;
  nodes(): { call(command: string, ...args: (string | number)[]): Promise<unknown> }[];
  sendCommand(name: string, args?: (string | number)[]): Promise<unknown>;
}

/** 扫描每页的键数。 */
const PATTERN_SCAN_COUNT = 500;
/** cluster 逐键删除的分片并发度（同一 socket 流水化，缩短 runExclusive 持有时间）。 */
const CLUSTER_UNLINK_CHUNK = 64;

/** 删除失败时抛出，携带已删除数量（供审计/提示部分删除）。 */
export class PatternDeleteError extends Error {
  constructor(message: string, public readonly deleted: number) {
    super(message);
    this.name = 'PatternDeleteError';
  }
}

/**
 * 按 pattern 全量扫描；cluster 逐 master。`onKeys(keys)` 处理每页（可空）。
 * 返回扫描命中总键数。
 */
export async function scanPatternKeys(
  client: RedisPatternClient,
  pattern: string,
  onKeys: (keys: string[]) => Promise<void> | void = () => { /* count only */ },
): Promise<number> {
  let total = 0;
  if (client.isCluster) {
    for (const node of client.nodes()) {
      let cursor = '0';
      do {
        const page = await redisScanOnNode(node, cursor, { match: pattern, count: PATTERN_SCAN_COUNT });
        cursor = page.cursor;
        total += page.keys.length;
        if (page.keys.length) await onKeys(page.keys);
      } while (cursor !== '0');
    }
    return total;
  }
  let cursor = '0';
  do {
    const page = await redisScan(client, cursor, { match: pattern, count: PATTERN_SCAN_COUNT });
    cursor = page.cursor;
    total += page.keys.length;
    if (page.keys.length) await onKeys(page.keys);
  } while (cursor !== '0');
  return total;
}

/**
 * 按 pattern 删除，返回**实际删除数**（`UNLINK` 返回值累计）。
 * cluster 逐键、分片并发；standalone 多键一批。
 * 中途失败抛 `PatternDeleteError`（带已删除数），避免「部分删除却无审计/无计数」。
 */
export async function deleteByPatternKeys(client: RedisPatternClient, pattern: string): Promise<number> {
  let deleted = 0;
  try {
    await scanPatternKeys(client, pattern, async (keys) => {
      if (client.isCluster) {
        for (let i = 0; i < keys.length; i += CLUSTER_UNLINK_CHUNK) {
          const chunk = keys.slice(i, i + CLUSTER_UNLINK_CHUNK);
          const results = await Promise.all(chunk.map((key) => redisUnlink(client, [key])));
          deleted += results.reduce((a, b) => a + b, 0);
        }
        return;
      }
      deleted += await redisUnlink(client, keys);
    });
  } catch (err) {
    throw new PatternDeleteError((err as Error).message, deleted);
  }
  return deleted;
}