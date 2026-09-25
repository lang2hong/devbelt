/**
 * Redis 能力声明（P7）。
 *
 * 与 SQL 的 `DatabaseCapabilities` 同层概念但**不共享接口**：Redis 的能力面
 * （cluster/sentinel/CLI/key browser/五类型/stream/slowlog…）与 SQL 完全不同。
 *
 * 标志按**当前已交付切片**如实设置，UI 据此收敛入口；未交付的能力保持 false，
 * 在对应功能落地时才翻开（如 Stream viewer 落地再开 `stream`）。
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

/** 当前已交付能力集合（键树/五类型/cluster/sentinel；Stream viewer 未交付 → false）。 */
export const REDIS_CAPABILITIES: RedisCapabilities = {
  standalone: true,
  // S4：Cluster/Sentinel
  cluster: true,
  sentinel: true,
  tls: true,
  sshTunnel: true,
  readOnly: true,
  cli: true,
  serverInfo: true,
  slowLog: true,
  // S3：键树、五类型 viewer/editor
  keyBrowser: true,
  fiveTypes: true,
  // S4 项 3：Stream viewer/editor
  stream: true,
};
