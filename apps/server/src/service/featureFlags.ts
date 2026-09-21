/**
 * 功能开关服务（P4 切片 4A / Runbook §3）。
 *
 * 三类预留开关默认启用（fail-open，仅显式关闭才生效）：
 *   - `browser-auth`  → env `DEVBELT_DB_FEATURE_BROWSER_AUTH`（**预留，未接线**）
 *   - `mail-flow`     → env `DEVBELT_DB_FEATURE_MAIL_FLOW`（**预留，未接线**）
 *   - `sync-handoff`  → env `DEVBELT_DB_FEATURE_SYNC_HANDOFF`（**预留，未接线**）
 *
 * `payment` 为 **opt-in 默认关闭**（`DEVBELT_DB_FEATURE_PAYMENT=true/1/on` 才启用）：
 * 资金面集成中「配凭据」与「开启客户支付」是两次独立上线动作，仅配凭据不得默认暴露下单/回调路由。
 *
 * 关闭语义（§11.4）：命中开关关闭的请求返回 503 `FEATURE_TEMPORARILY_DISABLED`，
 * **不回退到旧的弱安全链路**。`payment` 已接线；其余三类是**预留命名**，
 * 在对应路由接入开关守卫前不产生运行时行为（不应被理解为已可运维的部署开关）。
 */

export interface FeatureFlagSet {
  'browser-auth': boolean;
  'mail-flow': boolean;
  'sync-handoff': boolean;
  payment: boolean;
}

const FLAG_ENV_KEYS: Readonly<Record<keyof FeatureFlagSet, string>> = {
  'browser-auth': 'DEVBELT_DB_FEATURE_BROWSER_AUTH',
  'mail-flow': 'DEVBELT_DB_FEATURE_MAIL_FLOW',
  'sync-handoff': 'DEVBELT_DB_FEATURE_SYNC_HANDOFF',
  payment: 'DEVBELT_DB_FEATURE_PAYMENT',
};

/** 关闭值判定：`false` / `0` / `off`（不分大小写）视为关闭。缺省/其它一律启用。 */
function parseOff(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'off';
}

/** 开启值判定（严格 opt-in）：仅 `true` / `1` / `on` 视为开启，缺省/其它一律关闭。 */
function parseOn(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

/**
 * 默认关闭（opt-in）的开关：资金面集成必须显式开启，仅配凭据不启用。
 * 其余（browser-auth / mail-flow / sync-handoff）保持默认启用的预留 fail-open 语义不变。
 */
const DEFAULT_OFF_FLAGS: ReadonlySet<keyof FeatureFlagSet> = new Set(['payment']);

export class FeatureFlags {
  constructor(private readonly values: FeatureFlagSet) {}

  enabled(name: keyof FeatureFlagSet): boolean {
    return this.values[name];
  }
}

/** 从环境解析功能开关（纯函数，便于测试）。payment 默认关闭（opt-in），其余默认启用。 */
export function resolveFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  const values = {} as FeatureFlagSet;
  for (const [name, key] of Object.entries(FLAG_ENV_KEYS) as Array<[keyof FeatureFlagSet, string]>) {
    values[name] = DEFAULT_OFF_FLAGS.has(name) ? parseOn(env[key]) : !parseOff(env[key]);
  }
  return new FeatureFlags(values);
}