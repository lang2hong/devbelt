/**
 * 扩展匿名安装/活跃心跳（016）。
 *
 * 只记录随机 `install_id` 与首次/最近心跳时间；不关联账号、不存邮箱、不存 IP。
 * `first_seen` 即“首次激活”口径的安装，`last_seen` 用于滚动活跃窗口。
 */
export interface TelemetryHeartbeat {
  installId: string;
  appVersion: string;
  os: string | null;
  arch: string | null;
  isRemote: boolean;
}

export interface TelemetryOverview {
  totalInstalls: number;
  newInstalls7d: number;
  newInstalls30d: number;
  active24h: number;
  active7d: number;
  active30d: number;
  /** 近 30 天（UTC），无数据的日期补 0。 */
  daily: TelemetryDailyPoint[];
}

export interface TelemetryDailyPoint {
  /** `YYYY-MM-DD`（UTC）。 */
  day: string;
  newInstalls: number;
  activeInstalls: number;
}

export interface ITelemetryRepo {
  record(input: TelemetryHeartbeat): Promise<void>;
  overview(): Promise<TelemetryOverview>;
}