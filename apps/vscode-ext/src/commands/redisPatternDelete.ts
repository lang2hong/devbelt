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

/**
 * 分页锁钩子（D11）：每页 `[select → SCAN → onKeys]` 在同一排他锁内执行、页间释放，
 * 避免大 keyspace 全量删除长时间独占共享会话；缺省不传则保持旧行为（调用方整段持锁）。
 */
export interface PatternPageHooks {
  /** 排他锁包装（如 `client.runExclusive`）。 */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** 每页锁内重新归一目标库（非 cluster；锁间其它面板可能改变 SELECT）。 */
  select?: () => Promise<void>;
}

async function withPageLock<T>(hooks: PatternPageHooks | undefined, fn: () => Promise<T>): Promise<T> {
  if (!hooks?.withLock) return fn();
  return hooks.withLock(async () => {
    await hooks.select?.();
    return fn();
  });
}

/** 删除失败时抛出，携带已删除数量（供审计/提示部分删除）。 */
export class PatternDeleteError extends Error {
  constructor(message: string, public readonly deleted: number) {
    super(message);
    this.name = 'PatternDeleteError';
  }
}

/**
 * 按 pattern 全量扫描；cluster 逐 master。`onKeys(keys)` 处理每页（可空）。
 * 返回扫描命中总键数。传入 `hooks` 时每页在排他锁内执行（页间释放）。
 */
export async function scanPatternKeys(
  client: RedisPatternClient,
  pattern: string,
  onKeys: (keys: string[]) => Promise<void> | void = () => { /* count only */ },
  hooks?: PatternPageHooks,
): Promise<number> {
  let total = 0;
  if (client.isCluster) {
    for (const node of client.nodes()) {
      let cursor = '0';
      do {
        let keys: string[] = [];
        cursor = await withPageLock(hooks, async () => {
          const page = await redisScanOnNode(node, cursor, { match: pattern, count: PATTERN_SCAN_COUNT });
          if (page.keys.length) await onKeys(page.keys);
          keys = page.keys;
          return page.cursor;
        });
        total += keys.length;
      } while (cursor !== '0');
    }
    return total;
  }
  let cursor = '0';
  do {
    let keys: string[] = [];
    cursor = await withPageLock(hooks, async () => {
      const page = await redisScan(client, cursor, { match: pattern, count: PATTERN_SCAN_COUNT });
      if (page.keys.length) await onKeys(page.keys);
      keys = page.keys;
      return page.cursor;
    });
    total += keys.length;
  } while (cursor !== '0');
  return total;
}

/**
 * 按 pattern 删除，返回**实际删除数**（`UNLINK` 返回值累计）。
 * cluster 逐键、分片并发；standalone 多键一批。
 * 传入 `hooks` 时每页 `[select → SCAN → UNLINK]` 在排他锁内（页间释放）。
 * 中途失败抛 `PatternDeleteError`（带已删除数），避免「部分删除却无审计/无计数」。
 */
export async function deleteByPatternKeys(client: RedisPatternClient, pattern: string, hooks?: PatternPageHooks): Promise<number> {
  let deleted = 0;
  try {
    await scanPatternKeys(client, pattern, async (keys) => {
      if (client.isCluster) {
        for (let i = 0; i < keys.length; i += CLUSTER_UNLINK_CHUNK) {
          const chunk = keys.slice(i, i + CLUSTER_UNLINK_CHUNK);
          // allSettled：并发但仍精确累计已删数；中途失败也先记下成功数再抛（避免悲观少算）。
          const settled = await Promise.allSettled(chunk.map((key) => redisUnlink(client, [key])));
          let firstErr: unknown;
          for (const r of settled) {
            if (r.status === 'fulfilled') deleted += r.value;
            else if (firstErr === undefined) firstErr = r.reason;
          }
          if (firstErr !== undefined) throw firstErr;
        }
        return;
      }
      deleted += await redisUnlink(client, keys);
    }, hooks);
  } catch (err) {
    throw new PatternDeleteError((err as Error).message, deleted);
  }
  return deleted;
}