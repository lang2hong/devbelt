import { t, isZhRef } from '../composables/useI18n';

/**
 * 套餐特征展示（webview 侧）：与 console-ui/src/lib/planFeatures.ts 同口径，
 * 但文案走 i18n（`plan.feature.*`）。未知 key 优雅降级为 key、按 type 通用格式化，
 * 因此服务端新增特征维度时这里无需改动。
 */

export type FeatureType = 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';

export interface PlanFeatureDto {
  key: string;
  type: FeatureType;
  value: boolean | number | string | string[];
  /** 服务端特性定义标签（单源）；缺失时回退本地 i18n 映射。 */
  label?: { en: string; zh: string };
}

export interface PlanDto {
  code: string;
  name: string;
  billing: { unit: 'month' | 'seat-month'; priceCents: number };
  features: PlanFeatureDto[];
}

export interface PlanCatalog {
  personal: PlanDto[];
  organization: PlanDto[];
}

const FEATURE_KEYS = new Set([
  'allowedDatabaseTypes',
  'allowedTemplateDatabaseTypes',
  'maxSavedConnections',
  'maxConnectionMetas',
  'syncStorageBytes',
  'allowConnectionImport',
  'maxDevices',
  'includedSeats',
  'maxSharedResources',
  'sharedStorageQuotaBytes',
]);

/** 已支持的引擎；其余视为「即将支持」（仅展示、不解锁）。 */
const ENGINE_LABELS: Record<string, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
};

const ENGINE_KEYS = new Set(['allowedDatabaseTypes', 'allowedTemplateDatabaseTypes']);

export function featureLabel(key: string, label?: { en: string; zh: string }): string {
  // 服务端定义优先（单源），按当前语言取；缺失时回退本地 i18n 映射。
  if (label) return isZhRef.value ? (label.zh || label.en) : (label.en || label.zh);
  return FEATURE_KEYS.has(key) ? t(`plan.feature.${key}`) : key;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return t('plan.unlimited');
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function formatEngineList(value: string[]): string {
  if (value.length === 0) return '—';
  return value.map((v) => (ENGINE_LABELS[v] ? ENGINE_LABELS[v] : t('plan.comingSoon', { name: v }))).join('、');
}

export function formatFeature(feature: PlanFeatureDto): string {
  if (feature.type === 'bool') return feature.value === true ? t('plan.supported') : t('plan.unsupported');
  if (feature.type === 'bytes') return formatBytes(Number(feature.value) || 0);
  if (feature.type === 'stringList') {
    const list = Array.isArray(feature.value) ? feature.value : [];
    return ENGINE_KEYS.has(feature.key) ? formatEngineList(list) : list.join('、') || '—';
  }
  if (feature.type === 'number') {
    const n = Number(feature.value) || 0;
    return n === 0 ? t('plan.unlimited') : String(n);
  }
  return String(feature.value);
}

/** 价格文案：个人 0 = 免费；组织席位 0 = 待定价。 */
export function formatPrice(billing: PlanDto['billing']): string {
  if (billing.priceCents === 0) {
    return billing.unit === 'month' ? t('plan.free') : t('plan.pendingPrice');
  }
  const yuan = billing.priceCents / 100;
  const amount = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  return billing.unit === 'month' ? t('plan.perMonth', { amount }) : t('plan.perSeatMonth', { amount });
}