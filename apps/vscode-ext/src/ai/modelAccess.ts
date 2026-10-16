/**
 * AI 模型接入（自带 Key 模式）的纯函数与内置预设（无 vscode 依赖，host 与 webview 均可导入）。
 *
 * - 厂商目录由管理后台维护（`GET /api/ai/providers`）；服务端不可达时回退到 BUILTIN_PROVIDERS；
 * - 用户可自建厂商（名称 + baseUrl）与自定义模型；
 * - baseUrl 规整：https 必须；`http` 仅允许回环地址（本地模型/调试），避免 Key 明文外发；
 * - 同步项（当前选择 / 自定义厂商与模型 / API Key）为**本机**勾选，不随同步走；
 *   接收端按组合并：未勾选/未出现的组保留本机值。
 */

export interface CatalogModel {
  id: string;
  label?: string;
  default?: boolean;
}

export interface CatalogProvider {
  code: string;
  name: { en: string; zh: string };
  baseUrl: string;
  models: CatalogModel[];
  sortOrder: number;
}

/** 用户自建厂商（与 db-host SyncAiCustomVendor 结构一致）。 */
export interface CustomVendor {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}

/** 同步项勾选（本机设置；默认全开）。 */
export interface ModelAccessSyncPrefs {
  selection: boolean;
  custom: boolean;
  key: boolean;
}

export const DEFAULT_MODEL_ACCESS_PREFS: ModelAccessSyncPrefs = { selection: true, custom: true, key: true };

/** 内置兜底预设（与服务端迁移 010 的预置一致；运营可在后台调整，客户端以服务端为准）。 */
export const BUILTIN_PROVIDERS: readonly CatalogProvider[] = [
  { code: 'openai', name: { en: 'OpenAI', zh: 'OpenAI' }, baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-4o-mini', default: true }, { id: 'gpt-4o' }, { id: 'gpt-4.1-mini' }], sortOrder: 10 },
  { code: 'dashscope', name: { en: 'Alibaba Bailian', zh: '阿里百炼' }, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'qwen-plus', default: true }, { id: 'qwen-max' }, { id: 'qwen-turbo' }], sortOrder: 20 },
  { code: 'deepseek', name: { en: 'DeepSeek', zh: 'DeepSeek' }, baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat', default: true }, { id: 'deepseek-reasoner' }], sortOrder: 30 },
  { code: 'zhipu', name: { en: 'Zhipu AI', zh: '智谱' }, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4-plus', default: true }, { id: 'glm-4-air' }, { id: 'glm-4-flash' }], sortOrder: 40 },
  { code: 'xiaomi', name: { en: 'Xiaomi MiMo', zh: '小米 MiMo' }, baseUrl: 'https://api.xiaomimimo.com/v1', models: [{ id: 'mimo-v2.6-flash', default: true }, { id: 'mimo-v2.6-pro' }], sortOrder: 50 },
  { code: 'moonshot', name: { en: 'Moonshot (Kimi)', zh: 'Moonshot（Kimi）' }, baseUrl: 'https://api.moonshot.cn/v1', models: [{ id: 'moonshot-v1-8k', default: true }, { id: 'moonshot-v1-32k' }], sortOrder: 60 },
  { code: 'siliconflow', name: { en: 'SiliconFlow', zh: '硅基流动' }, baseUrl: 'https://api.siliconflow.cn/v1', models: [{ id: 'Qwen/Qwen2.5-72B-Instruct', default: true }, { id: 'deepseek-ai/DeepSeek-V3' }, { id: 'Qwen/Qwen2.5-Coder-32B-Instruct' }], sortOrder: 70 },
  { code: 'minimax', name: { en: 'MiniMax', zh: 'MiniMax' }, baseUrl: 'https://api.minimaxi.com/v1', models: [{ id: 'MiniMax-M3', default: true }, { id: 'MiniMax-M2' }], sortOrder: 80 },
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type BaseUrlResult = { ok: true; url: string } | { ok: false; reason: 'invalid' | 'insecure' };

/**
 * baseUrl 规整：https；`http` 仅回环；禁内嵌凭据/query/hash；去尾斜杠。
 * （用户 API Key 会发往该地址，因此不接受明文 http 的远程地址。）
 */
export function normalizeBaseUrl(raw: unknown): BaseUrlResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
  const text = raw.trim();
  if (!text || text.length > 255) return { ok: false, reason: 'invalid' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username || url.password || url.search || url.hash) return { ok: false, reason: 'invalid' };
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: 'insecure' };
  } else if (url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** 实际请求地址（用于弹层明示「密钥将发送到」）。 */
export function chatEndpointOf(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 该 baseUrl 的主机是否属于任一已知厂商（预设或用户自建；自定义地址的提示依据）。 */
export function isKnownProviderHost(baseUrl: string, catalog: readonly CatalogProvider[], customVendors: readonly CustomVendor[] = []): boolean {
  try {
    const host = new URL(baseUrl).host;
    const known = [...catalog.map((p) => p.baseUrl), ...customVendors.map((v) => v.baseUrl)];
    return known.some((b) => {
      try {
        return new URL(b).host === host;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// ── 目录响应校验（服务端返回视为不可信输入）──

export function parseCatalogResponse(raw: unknown): CatalogProvider[] | undefined {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  const out: CatalogProvider[] = [];
  for (const it of items) {
    const o = (it ?? {}) as Record<string, unknown>;
    const name = (o.name ?? {}) as Record<string, unknown>;
    const base = normalizeBaseUrl(o.baseUrl);
    // 目录下发的地址只接受 https（回环 http 仅限用户自建）。
    if (typeof o.code !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(o.code)) continue;
    if (!base.ok || !base.url.startsWith('https://')) continue;
    if (typeof name.en !== 'string' || typeof name.zh !== 'string' || !name.en || !name.zh) continue;
    if (!Array.isArray(o.models) || o.models.length === 0) continue;
    const models: CatalogModel[] = [];
    for (const m of o.models.slice(0, 50)) {
      const mo = (m ?? {}) as Record<string, unknown>;
      if (typeof mo.id !== 'string' || !mo.id || mo.id.length > 128 || /\s/.test(mo.id)) continue;
      models.push({
        id: mo.id,
        ...(typeof mo.label === 'string' && mo.label ? { label: mo.label.slice(0, 64) } : {}),
        ...(mo.default === true ? { default: true } : {}),
      });
    }
    if (models.length === 0) continue;
    out.push({
      code: o.code,
      name: { en: name.en.slice(0, 64), zh: name.zh.slice(0, 64) },
      baseUrl: base.url,
      models,
      sortOrder: Number.isSafeInteger(o.sortOrder) ? (o.sortOrder as number) : 0,
    });
  }
  return out.length > 0 ? out.sort((a, b) => a.sortOrder - b.sortOrder) : undefined;
}

// ── 保存载荷（webview 上行，不可信输入）──

export interface ModelAccessSaveInput {
  mode: 'server-proxy' | 'openai-compatible';
  vendorId: string;
  baseUrl: string;
  model: string;
  customVendors: CustomVendor[];
  customModels: Record<string, string[]>;
  /** 新填写的 API Key；空 = 保持本机已有。 */
  apiKey: string;
  clearKey: boolean;
  prefs: ModelAccessSyncPrefs;
}

export type ModelAccessSaveError = 'invalid' | 'baseUrl' | 'insecure' | 'model' | 'vendors';

export type ModelAccessSaveResult = { ok: true; value: ModelAccessSaveInput } | { ok: false; error: ModelAccessSaveError };

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

/** 校验保存载荷。error 为稳定错误码（UI 本地化）。 */
export function parseModelAccessSave(raw: unknown): ModelAccessSaveResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid' };
  const o = raw as Record<string, unknown>;
  if (o.mode !== 'server-proxy' && o.mode !== 'openai-compatible') return { ok: false, error: 'invalid' };
  const vendorId = str(o.vendorId ?? '', 64);
  const model = str(o.model ?? '', 128);
  const apiKey = str(o.apiKey ?? '', 512);
  if (vendorId === undefined || model === undefined || apiKey === undefined) return { ok: false, error: 'invalid' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(apiKey)) return { ok: false, error: 'invalid' };

  const prefsRaw = (o.prefs ?? {}) as Record<string, unknown>;
  const prefs: ModelAccessSyncPrefs = {
    selection: prefsRaw.selection !== false,
    custom: prefsRaw.custom !== false,
    key: prefsRaw.key !== false,
  };

  const vendorsRaw = o.customVendors === undefined ? [] : o.customVendors;
  const modelsRaw = o.customModels === undefined ? {} : o.customModels;
  if (!Array.isArray(vendorsRaw) || vendorsRaw.length > 20) return { ok: false, error: 'vendors' };
  const customVendors: CustomVendor[] = [];
  const seen = new Set<string>();
  for (const item of vendorsRaw) {
    const v = (item ?? {}) as Record<string, unknown>;
    const id = str(v.id, 64);
    const name = str(v.name, 64);
    const base = normalizeBaseUrl(v.baseUrl);
    if (!id || !name || !base.ok) return { ok: false, error: 'vendors' };
    if (seen.has(id)) return { ok: false, error: 'vendors' };
    seen.add(id);
    const models = Array.isArray(v.models) ? v.models : [];
    if (models.length > 50 || models.some((m) => typeof m !== 'string' || !m || m.length > 128)) return { ok: false, error: 'vendors' };
    customVendors.push({ id, name, baseUrl: base.url, models: models as string[] });
  }
  if (typeof modelsRaw !== 'object' || modelsRaw === null || Array.isArray(modelsRaw)) return { ok: false, error: 'vendors' };
  const customModels: Record<string, string[]> = {};
  for (const k of Object.keys(modelsRaw).slice(0, 30)) {
    const list = (modelsRaw as Record<string, unknown>)[k];
    if (!Array.isArray(list) || list.length > 50 || list.some((m) => typeof m !== 'string' || !m || m.length > 128)) return { ok: false, error: 'vendors' };
    customModels[k] = list as string[];
  }

  const value: ModelAccessSaveInput = {
    mode: o.mode,
    vendorId,
    baseUrl: '',
    model: model.trim(),
    customVendors,
    customModels,
    apiKey,
    clearKey: o.clearKey === true,
    prefs,
  };
  if (o.mode === 'server-proxy') return { ok: true, value };

  const url = normalizeBaseUrl(o.baseUrl);
  if (!url.ok) return { ok: false, error: url.reason === 'insecure' ? 'insecure' : 'baseUrl' };
  if (!value.model) return { ok: false, error: 'model' };
  if (/[\u0000-\u001f\s]/.test(value.model)) return { ok: false, error: 'model' };
  return { ok: true, value: { ...value, baseUrl: url.url } };
}

// ── 连接测试结果 ──

export interface ModelAccessTestResult {
  ok: boolean;
  /** 稳定原因码（UI 本地化）：ok / nokey / auth / model / network / timeout / rate / server / unknown。 */
  code: 'ok' | 'nokey' | 'auth' | 'model' | 'network' | 'timeout' | 'rate' | 'server' | 'unknown';
  latencyMs: number;
  status?: number;
  /** 错误摘要（已截断，不含 Key）。 */
  detail?: string;
}

/** 把测试请求的失败映射为稳定原因码（依据 HTTP 状态与常见错误文本）。 */
export function classifyTestError(err: unknown, latencyMs: number): ModelAccessTestResult {
  const e = (err ?? {}) as { message?: unknown; status?: unknown; code?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  const fromMessage = /\b(?:HTTP|status)\s*(\d{3})\b/i.exec(message)?.[1];
  const status = typeof e.status === 'number' ? e.status : fromMessage ? Number(fromMessage) : undefined;
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  const base = { ok: false as const, latencyMs, ...(status !== undefined ? { status } : {}), detail };
  if (status === 401 || status === 403) return { ...base, code: 'auth' };
  if (status === 404 || (/model/i.test(message) && /(not\s*found|not\s*exist|invalid|unknown|不存在)/i.test(message))) return { ...base, code: 'model' };
  if (status === 429) return { ...base, code: 'rate' };
  if (status !== undefined && status >= 500) return { ...base, code: 'server' };
  if (/timeout|timed out|abort/i.test(message) || e.code === 'ETIMEDOUT') return { ...base, code: 'timeout' };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(message)) return { ...base, code: 'network' };
  return { ...base, code: 'unknown' };
}
