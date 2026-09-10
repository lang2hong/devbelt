/**
 * 功能开关服务（P4 切片 4A / Runbook §3）。
 *
 * 每个开关独立、默认启用，仅显式关闭才生效：
 *   - `browser-auth`  → env `FEATURE_BROWSER_AUTH`
 *   - `mail-flow`     → env `FEATURE_MAIL_FLOW`
 *   - `sync-handoff`  → env `FEATURE_SYNC_HANDOFF`
 *   - `payment`       → env `FEATURE_PAYMENT`
 *
 * 关闭语义（§11.4）：命中开关关闭的请求返回 503 `FEATURE_TEMPORARILY_DISABLED`，
 * **不回退到旧的弱安全链路**。当前切片只落地 `payment` 开关的拦截；其余三类开关
 * 作为部署事实落地时按同名约定接入（故此接口泛化）。
 */

export interface FeatureFlagSet {
  'browser-auth': boolean;
  'mail-flow': boolean;
  'sync-handoff': boolean;
  payment: boolean;
}

const FLAG_ENV_KEYS: Readonly<Record<keyof FeatureFlagSet, string>> = {
  'browser-auth': 'FEATURE_BROWSER_AUTH',
  'mail-flow': 'FEATURE_MAIL_FLOW',
  'sync-handoff': 'FEATURE_SYNC_HANDOFF',
  payment: 'FEATURE_PAYMENT',
};

/** 关闭值判定：`false` / `0` / `off`（不分大小写）视为关闭。缺省/其它一律启用。 */
function parseOff(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'off';
}

export class FeatureFlags {
  constructor(private readonly values: FeatureFlagSet) {}

  enabled(name: keyof FeatureFlagSet): boolean {
    return this.values[name];
  }
}

/** 从环境解析功能开关（纯函数，便于测试）。缺省全部启用。 */
export function resolveFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const values = {} as FeatureFlagSet;
  for (const [name, key] of Object.entries(FLAG_ENV_KEYS) as Array<[keyof FeatureFlagSet, string]>) {
    values[name] = !parseOff(env[key]);
  }
  return new FeatureFlags(values);
}