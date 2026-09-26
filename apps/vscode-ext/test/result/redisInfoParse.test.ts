import { describe, expect, it } from 'vitest';
import { aggregateRedisInfo, parseRedisInfo } from '../../src/result/redisInfoParse';

const INFO = `# Server
redis_version:7.2.4
redis_mode:standalone
role:master
uptime_in_seconds:3600
# Clients
connected_clients:5
# Stats
total_commands_processed:123456
instantaneous_ops_per_sec:42
instantaneous_input_kbps:1.5
instantaneous_output_kbps:2.5
keyspace_hits:90
keyspace_misses:10
evicted_keys:2
expired_keys:7
# Memory
used_memory:1048576
used_memory_human:1.00M
maxmemory:0
mem_fragmentation_ratio:1.25
# Keyspace
db1:keys=5,expires=0,avg_ttl=0
db0:keys=100,expires=3,avg_ttl=0
`;

describe('parseRedisInfo（监控指标解析）', () => {
  it('解析关键字段、命中率与键空间（db 排序）', () => {
    const m = parseRedisInfo(INFO, 1000);
    expect(m.ts).toBe(1000);
    expect(m.version).toBe('7.2.4');
    expect(m.role).toBe('master');
    expect(m.uptimeSeconds).toBe(3600);
    expect(m.connectedClients).toBe(5);
    expect(m.usedMemory).toBe(1048576);
    expect(m.usedMemoryHuman).toBe('1.00M');
    expect(m.instantaneousOpsPerSec).toBe(42);
    expect(m.instantaneousInputKbps).toBe(1.5);
    expect(m.instantaneousOutputKbps).toBe(2.5);
    expect(m.evictedKeys).toBe(2);
    expect(m.expiredKeys).toBe(7);
    expect(m.hitRate).toBeCloseTo(0.9);
    expect(m.keyspace).toEqual([
      { db: 'db0', keys: 100, expires: 3 },
      { db: 'db1', keys: 5, expires: 0 },
    ]);
  });

  it('无读写（hits+misses=0）→ hitRate null；缺字段 → 0/空', () => {
    const m = parseRedisInfo('redis_version:7\nkeyspace_hits:0\nkeyspace_misses:0');
    expect(m.hitRate).toBeNull();
    expect(m.usedMemory).toBe(0);
    expect(m.role).toBe('');
    expect(m.fragmentationRatio).toBe(0);
    expect(m.keyspace).toEqual([]);
  });

  it('忽略空行与非 key:value 行', () => {
    const m = parseRedisInfo('\n# Section\nnot-a-kv\nused_memory:5\n');
    expect(m.usedMemory).toBe(5);
    expect(m.version).toBe('');
  });
});

describe('aggregateRedisInfo（cluster 逐 master 聚合）', () => {
  const a = parseRedisInfo(
    'role:master\nused_memory:100\nconnected_clients:2\nkeyspace_hits:8\nkeyspace_misses:2\ninstantaneous_ops_per_sec:10\nuptime_in_seconds:100\nmem_fragmentation_ratio:1.5\ndb0:keys=3,expires=0,avg_ttl=0\n',
    1,
  );
  const b = parseRedisInfo(
    'role:master\nused_memory:50\nconnected_clients:1\nkeyspace_hits:0\nkeyspace_misses:0\ninstantaneous_ops_per_sec:5\nuptime_in_seconds:200\nmem_fragmentation_ratio:1.1\ndb0:keys=7,expires=1,avg_ttl=0\ndb1:keys=2,expires=0,avg_ttl=0\n',
    2,
  );

  it('计数/内存/ops 求和、keyspace 合并、uptime/碎片率取最大、role=cluster、命中率重算', () => {
    const m = aggregateRedisInfo([a, b], 9);
    expect(m.ts).toBe(9);
    expect(m.role).toBe('cluster');
    expect(m.usedMemory).toBe(150);
    expect(m.connectedClients).toBe(3);
    expect(m.instantaneousOpsPerSec).toBe(15);
    expect(m.totalCommandsProcessed).toBe(0);
    expect(m.uptimeSeconds).toBe(200);
    expect(m.fragmentationRatio).toBe(1.5);
    expect(m.hitRate).toBeCloseTo(0.8);
    expect(m.keyspace).toEqual([
      { db: 'db0', keys: 10, expires: 1 },
      { db: 'db1', keys: 2, expires: 0 },
    ]);
  });

  it('空列表退化为空采样；单元素仅更新时间戳', () => {
    expect(aggregateRedisInfo([], 5).ts).toBe(5);
    expect(aggregateRedisInfo([], 5).keyspace).toEqual([]);
    expect(aggregateRedisInfo([a], 5)).toEqual({ ...a, ts: 5 });
  });
});