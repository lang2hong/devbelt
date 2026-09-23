/**
 * 套餐特征展示：服务端 /api/db/plans 下发 `features: {key,type,value}` 描述符，这里按 key
 * 渲染中文标签与格式化文本。未知 key 优雅降级（标签用 key、按 type 通用格式化），
 * 因此服务端新增特征维度时前端无需改动即可展示。
 */

export type FeatureType = 'bool' | 'number' | 'bytes' | 'stringList' | 'enum';

export interface FeatureDto {
  key: string;
  type: FeatureType;
  value: boolean | number | string | string[];
  /** 服务端特性定义标签（单源）；缺失时回退本地 i18n 映射。 */
  label?: { en: string; zh: string };
}

export type BillingUnit = 'month' | 'seat-month';

export interface PlanDto {
  code: string;
  name: string;
  billing: { unit: BillingUnit; priceCents: number };
  features: FeatureDto[];
}

export interface PlanCatalog {
  personal: PlanDto[];
}

/** 已知特征标签（缺失时回落为 key）。 */
const FEATURE_LABELS: Record<string, string> = {
  allowedDatabaseTypes: '支持的数据库',
  maxSavedConnections: '本机保存连接数',
  maxConnectionMetas: '云端连接元数据',
  syncStorageBytes: '云端同步空间',
  allowConnectionImport: '导入连接配置',
  maxDevices: '设备数',
};

/** 已支持的引擎（其余视为「即将支持」，仅展示、不解锁）。 */
const ENGINE_LABELS: Record<string, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
};

const ENGINE_KEYS = new Set(['allowedDatabaseTypes']);

export function featureLabel(key: string, label?: { en: string; zh: string }): string {
  // 服务端定义优先（单源）；控制台为中文，取 zh。
  if (label?.zh) return label.zh;
  return FEATURE_LABELS[key] ?? key;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '不限';
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function formatEngineList(value: string[]): string {
  if (value.length === 0) return '—';
  return value.map((v) => (ENGINE_LABELS[v] ? ENGINE_LABELS[v] : `${v}（即将支持）`)).join('、');
}

/** 把单个特征格式化为展示文本。0 表示「不限」；未知 key 按 type 通用处理。 */
export function formatFeature(feature: FeatureDto): string {
  if (feature.type === 'bool') return feature.value === true ? '支持' : '不支持';
  if (feature.type === 'bytes') return formatBytes(Number(feature.value) || 0);
  if (feature.type === 'stringList') {
    const list = Array.isArray(feature.value) ? feature.value : [];
    return ENGINE_KEYS.has(feature.key) ? formatEngineList(list) : list.join('、') || '—';
  }
  if (feature.type === 'number') {
    const n = Number(feature.value) || 0;
    return n === 0 ? '不限' : String(n);
  }
  return String(feature.value);
}

/** 价格文案：0 = 免费。 */
export function formatPrice(billing: PlanDto['billing']): string {
  if (billing.priceCents === 0) return billing.unit === 'month' ? '免费' : '待定价';
  const yuan = billing.priceCents / 100;
  const amount = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
  return billing.unit === 'month' ? `¥${amount} / 月` : `¥${amount} / 席·月`;
}