/**
 * Redis 能力声明（P7）。
 *
 * 与 SQL 的 `DatabaseCapabilities` 同层概念但**不共享接口**：Redis 的能力面
 * （cluster/sentinel/CLI/key browser/五类型/stream/slowlog…）与 SQL 完全不同。
 *
 * 标志按**当前已交付切片**如实设置，UI 据此收敛入口；S3 打开 keyBrowser/fiveTypes/stream，
 * S4 打开 cluster/sentinel。
 */
export interface RedisCapabilities {
  standalone: boolean;
  cluster: boolean;
  sentinel: boolean;
  tls: boolean;
  sshTunnel: boolean;
  readOnly: boolean;
  cli: boolean;
  serverInfo: boolean;
  slowLog: boolean;
  keyBrowser: boolean;
  fiveTypes: boolean;
  stream: boolean;
}

/** 当前切片（S2）的能力集合。 */
export const REDIS_CAPABILITIES: RedisCapabilities = {
  standalone: true,
  // S4：Cluster/Sentinel（含 NAT map）
  cluster: false,
  sentinel: false,
  tls: true,
  sshTunnel: true,
  readOnly: true,
  cli: true,
  serverInfo: true,
  slowLog: true,
  // S3：键树与五类型 viewer/editor / Stream
  keyBrowser: false,
  fiveTypes: false,
  stream: false,
};
