import { describe, expect, it } from 'vitest';
import {
  buildNatMap,
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
  it('远端地址映射到本地隧道端口', () => {
    expect(buildNatMap([{ remoteHost: '10.0.0.2', remotePort: 6379, localPort: 41001 }])).toEqual({
      '10.0.0.2:6379': { host: '127.0.0.1', port: 41001 },
    });
  });
});
