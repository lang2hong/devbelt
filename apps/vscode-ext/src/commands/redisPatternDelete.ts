/**
 * Redis 「按 pattern 全量扫描 / 删除」（C-3）。
 *
 * 纯逻辑，依赖最小 client 接口，便于单测。**cluster 必须逐 master**：`SCAN` 无 key，
 * ioredis 只会路由到单个节点；删除时多键跨 slot 会 CROSSSLOT。
 *
 * 删除一律经 client 的 `sendCommand`（即 `redisUnlink`）逐键/逐批执行：
 * cluster 逐键（按 slot 路由 + 仍经只读切面）；standalone 可多键一批。
 */
import { redisScan, redisScanOnNode, redisUnlink } from '@devbelt/db-core';

export interface RedisPatternClient {
  isCluster: boolean;
  nodes(): { call(command: string, ...args: (string | number)[]): Promise<unknown> }[];
  sendCommand(name: string, args?: (string | number)[]): Promise<unknown>;
}

/** 扫描每页的键数。 */
const PATTERN_SCAN_COUNT = 500;

/**
 * 按 pattern 全量扫描；cluster 逐 master。`onKeys(keys)` 处理每页（可空）。
 * 返回命中总键数。
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
 * 按 pattern 删除并返回命中数。
 * cluster 逐键 `UNLINK`（按 slot 路由 + 经只读切面）；standalone 多键一批。
 */
export function deleteByPatternKeys(client: RedisPatternClient, pattern: string): Promise<number> {
  return scanPatternKeys(client, pattern, async (keys) => {
    if (client.isCluster) {
      for (const key of keys) await redisUnlink(client, [key]);
    } else {
      await redisUnlink(client, keys);
    }
  });
}