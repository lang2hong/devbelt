import { describe, expect, it } from 'vitest';
import {
  UNMAPPED_DEAD_PORT,
  buildNatMap,
  createUnmappedNodeReporter,
  parseClusterNodesAll,
  parseClusterNodesMasters,
  parseSentinelMasterAddr,
} from '../../src/connection/redisTopology';

// 真实 `CLUSTER NODES` 文本样例（含 slave / myself,master / fail / 空行）。
const CLUSTER_NODES = `07c37dfeb235213a872192d90877d0cd55635b91 127.0.0.1:30004@31004 slave e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 0 1426238317239 4 connected
67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 127.0.0.1:30002@31002 master - 0 1426238316232 2 connected 5461-10922
292f8b365bb7edb5e285caf0b7e6ddc7265d2f4f 127.0.0.1:30003@31003 master - 0 1426238318243 3 connected 10923-16383
6ec23923021cf3ffec47632106199cb7f496ce01 127.0.0.1:30005@31005 master,fail - 0 0 0 disconnected
824fe116063bc5fcf9f4ffd895bc17aee7731ac3 127.0.0.1:30006@31006 myself,master - 0 0 1 connected 0-5460

`;

describe('parseClusterNodesMasters', () => {
  it('取 master 且排除 fail/slave，去重保序', () => {
    expect(parseClusterNodesMasters(CLUSTER_NODES)).toEqual([
      { host: '127.0.0.1', port: 30002 },
      { host: '127.0.0.1', port: 30003 },
      { host: '127.0.0.1', port: 30006 },
    ]);
  });

  it('畸形行安全跳过', () => {
    expect(parseClusterNodesMasters('garbage\n\n# comment')).toEqual([]);
  });

  it('parseClusterNodesAll：含副本、排除 fail、去重保序（SSH 隧道需覆盖全体）', () => {
    expect(parseClusterNodesAll(CLUSTER_NODES)).toEqual([
      { host: '127.0.0.1', port: 30004 },
      { host: '127.0.0.1', port: 30002 },
      { host: '127.0.0.1', port: 30003 },
      { host: '127.0.0.1', port: 30006 },
    ]);
  });
});

describe('parseSentinelMasterAddr', () => {
  it('解析 [host, port]；null/畸形返回 null', () => {
    expect(parseSentinelMasterAddr(['127.0.0.1', '6379'])).toEqual({ host: '127.0.0.1', port: 6379 });
    expect(parseSentinelMasterAddr(null)).toBeNull();
    expect(parseSentinelMasterAddr([])).toBeNull();
    expect(parseSentinelMasterAddr(['h', 'not-a-port'])).toBeNull();
  });
});

describe('buildNatMap', () => {
  it('已映射→本地隧道端口；未映射（含 loopback）一律死端口且不抛错', () => {
    const unmapped: string[] = [];
    const nat = buildNatMap([{ remoteHost: '10.0.0.2', remotePort: 6379, localPort: 41001 }], { onUnmapped: (a) => unmapped.push(a) });
    expect(nat('10.0.0.2:6379')).toEqual({ host: '127.0.0.1', port: 41001 });
    // ioredis 的 startupNodes 不走 natMapper，故不豁免 loopback：未映射（含 127.0.0.1）一律死端口。
    expect(nat('127.0.0.1:6379')).toEqual({ host: '127.0.0.1', port: UNMAPPED_DEAD_PORT });
    expect(nat('10.9.9.9:6379')).toEqual({ host: '127.0.0.1', port: UNMAPPED_DEAD_PORT });
    expect(unmapped).toEqual(['127.0.0.1:6379', '10.9.9.9:6379']);
    // 死端口不能是 0：ioredis 会把 port 0 回退成 6379，连到本机其它进程。
    expect(UNMAPPED_DEAD_PORT).not.toBe(0);
  });

  it('createUnmappedNodeReporter：日志每次、提示每连接一次', () => {
    const logs: string[] = [];
    const notes: string[] = [];
    const rep = createUnmappedNodeReporter((a) => logs.push(a), (a) => notes.push(a));
    rep.log('a:1');
    rep.notifyOnce('a:1');
    rep.log('b:2');
    rep.notifyOnce('b:2');
    expect(logs).toEqual(['a:1', 'b:2']);
    expect(notes).toEqual(['a:1']); // 同连接只提示一次
  });
});
