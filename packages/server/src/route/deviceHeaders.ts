import type { DeviceInfo } from '../service/authService.js';

/**
 * 设备请求头的列宽上界。
 *
 * 每个值都对齐 `repository/mysql/schema.ts` 里对应列的定义：
 *  - `refresh_tokens.device_name` VARCHAR(120) / `device_id` VARCHAR(64) / `user_agent` VARCHAR(255)
 *  - `devices.hostname` VARCHAR(120) / `os` VARCHAR(32) / `arch` VARCHAR(16) /
 *    `os_version` VARCHAR(64) / `app_name` VARCHAR(64) / `app_version` VARCHAR(32) /
 *    `remote_name` VARCHAR(32) / `vs_machine_id` VARCHAR(64) / `language` VARCHAR(16) /
 *    `timezone` VARCHAR(64)
 *
 * 改列宽时必须同步改这里，test/route/deviceHeaders.test.ts 有对齐断言兜着。
 */
export const DEVICE_HEADER_LIMITS = {
  deviceName: 120,
  deviceId: 64,
  machineId: 64,
  hostname: 120,
  os: 32,
  arch: 16,
  osVersion: 64,
  appName: 64,
  appVersion: 32,
  remoteName: 32,
  language: 16,
  timezone: 64,
  userAgent: 255,
} as const;

/** 头名 → DeviceInfo 字段名。集中一处，避免三个路由各写一遍还写歪。 */
const HEADER_MAP: ReadonlyArray<[string, keyof typeof DEVICE_HEADER_LIMITS]> = [
  ['x-device-name', 'deviceName'],
  ['x-device-id', 'deviceId'],
  ['x-device-machine-id', 'machineId'],
  ['x-device-hostname', 'hostname'],
  ['x-device-os', 'os'],
  ['x-device-arch', 'arch'],
  ['x-device-os-version', 'osVersion'],
  ['x-device-app', 'appName'],
  ['x-device-app-version', 'appVersion'],
  ['x-device-remote', 'remoteName'],
  ['x-device-language', 'language'],
  ['x-device-timezone', 'timezone'],
  ['user-agent', 'userAgent'],
];

/**
 * 读取设备头并按列宽截断。
 *
 * 为什么截断而不是用 JSON Schema 拒绝：
 *
 *  - `user-agent` 不由用户意图决定。某些代理/客户端的 UA 天然超过 255 字符，
 *    为它返回 400 等于让那批用户永远登不上，和原来的 500 一样是故障。
 *  - `x-device-id` 若在一处 400、另一处截断，同一个客户端会在不同端点得到
 *    不一致的结果。统一截断则同一个超长 id 在所有端点收敛到同一个值，
 *    `revokeByDevice` 的设备判同仍然成立。
 *
 * 不截断的后果（MySQL 8 默认 STRICT_TRANS_TABLES，超长报 ER_DATA_TOO_LONG 而非截断）：
 *
 *  - 登录：`deviceRepo.upsert` 抛错 → 500，登录彻底完不成。
 *  - 推送：`PUT /api/sync` 先提交 section（版本 N→N+1），再写 `sync_events`。
 *    后者抛错时前者不回滚，客户端收到 500 因而不更新本地 base，下次推送
 *    base=N 而服务端已是 N+1 → 该 section **永久 409**，只能靠 forcePush 脱困。
 *
 * `ip` 一律取 `req.ip`（受 trustProxy 语义约束），不接受客户端自述的任何头。
 */
export function readDeviceHeaders(req: {
  headers: Record<string, unknown>;
  ip?: string;
}): DeviceInfo {
  const out: DeviceInfo = { ip: req.ip };
  for (const [header, field] of HEADER_MAP) {
    const raw = req.headers[header];
    // 同名头出现多次时 Node 给的是数组；那不是本协议的合法形态，按缺失处理
    if (typeof raw !== 'string') continue;
    out[field] = raw.slice(0, DEVICE_HEADER_LIMITS[field]);
  }
  return out;
}

/** 只取 deviceId 的窄路径（sync / usage 只需要这一个字段）。 */
export function readDeviceId(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers['x-device-id'];
  if (typeof raw !== 'string' || raw === '') return undefined;
  return raw.slice(0, DEVICE_HEADER_LIMITS.deviceId);
}
