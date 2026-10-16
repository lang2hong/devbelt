/**
 * aiModelAccess 同步实体：AI Chat 自带 Key 模式的「模型接入配置」。
 *
 * 与 schemaNotes 同模式：db-host 定义类型/校验，宿主（vscode-ext）注入 `EntityBackend`。
 * 无跨实体引用。内容在端到端加密 record 内传输，服务端只见密文。
 *
 * **选择性同步（按子项）**：payload 分三组——「当前选择」/「自定义厂商与模型」/「API Key」。
 * 发送端只编码本机勾选的组；接收端合并时**缺省的组保留本机值**（不覆盖、不清空）。
 * 勾选状态本身是本机设置（不随同步走）。
 *
 * 体积 fail-closed：整体 JSON ≤ 32 KiB。
 */
export const AI_MODEL_ACCESS_MAX_BYTES = 32 * 1024;

export interface SyncAiCustomVendor {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}

/** 「当前选择」组：模式 / 厂商 / 地址 / 模型。 */
export interface AiModelAccessSelection {
  mode: 'server-proxy' | 'openai-compatible';
  /** 预设厂商 code、自定义厂商 id、或 ''（未选）。 */
  vendorId: string;
  baseUrl: string;
  model: string;
}

/** 「自定义厂商与模型」组。 */
export interface AiModelAccessCustom {
  customVendors: SyncAiCustomVendor[];
  /** vendorId → 用户手填的自定义模型。 */
  customModels: Record<string, string[]>;
}

/** 同步 payload（部分组：发送端按勾选裁剪）。 */
export interface AiModelAccessPayload {
  selection?: AiModelAccessSelection;
  custom?: AiModelAccessCustom;
  /** 仅勾选「同步 API Key」时携带。 */
  apiKey?: string;
}

/** 本地完整字段 = 选择 + 自定义（API Key 只存 SecretStorage，不落本地记录）。 */
export type AiModelAccessFields = AiModelAccessSelection & AiModelAccessCustom;

export interface SyncAiModelAccessValue extends AiModelAccessPayload {
  id: string;
  updateTime: number;
  deleted?: boolean;
}

function str(v: unknown, field: string, max: number, allowEmpty = true): string {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && v.length === 0)) {
    throw new Error(`aiModelAccess.${field} must be a string (<=${max} chars)`);
  }
  return v;
}

function strList(v: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(v) || v.length > maxItems) throw new Error(`aiModelAccess.${field} must be an array (<=${maxItems})`);
  return v.map((x, i) => str(x, `${field}[${i}]`, 128, false));
}

function assertSelection(raw: unknown): AiModelAccessSelection {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.mode !== 'server-proxy' && o.mode !== 'openai-compatible') throw new Error('aiModelAccess.selection.mode invalid');
  return {
    mode: o.mode,
    vendorId: str(o.vendorId ?? '', 'selection.vendorId', 64),
    baseUrl: str(o.baseUrl ?? '', 'selection.baseUrl', 255),
    model: str(o.model ?? '', 'selection.model', 128),
  };
}

function assertCustom(raw: unknown): AiModelAccessCustom {
  const o = (raw ?? {}) as Record<string, unknown>;
  const vendorsRaw = o.customVendors;
  if (!Array.isArray(vendorsRaw) || vendorsRaw.length > 20) throw new Error('aiModelAccess.custom.customVendors invalid');
  const customVendors = vendorsRaw.map((item, i): SyncAiCustomVendor => {
    const v = (item ?? {}) as Record<string, unknown>;
    return {
      id: str(v.id, `customVendors[${i}].id`, 64, false),
      name: str(v.name, `customVendors[${i}].name`, 64, false),
      baseUrl: str(v.baseUrl, `customVendors[${i}].baseUrl`, 255, false),
      models: strList(v.models ?? [], `customVendors[${i}].models`, 50),
    };
  });
  const modelsRaw = o.customModels;
  if (typeof modelsRaw !== 'object' || modelsRaw === null || Array.isArray(modelsRaw)) {
    throw new Error('aiModelAccess.custom.customModels invalid');
  }
  const keys = Object.keys(modelsRaw);
  if (keys.length > 30) throw new Error('aiModelAccess.custom.customModels too many vendors');
  const customModels: Record<string, string[]> = {};
  for (const k of keys) {
    str(k, 'customModels key', 64, false);
    customModels[k] = strList((modelsRaw as Record<string, unknown>)[k], `customModels.${k}`, 50);
  }
  return { customVendors, customModels };
}

/**
 * 校验并规整（编码与解码共用，fail-closed）：
 * - 各组可选（选择性同步）；至少一组存在（空 payload 无意义）；
 * - apiKey 拒绝空白/控制字符（会破坏 Authorization 头）；
 * - 整体 ≤ 32 KiB。
 */
export function assertAiModelAccessPayload(raw: unknown): AiModelAccessPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('aiModelAccess payload must be an object');
  const o = raw as Record<string, unknown>;
  const out: AiModelAccessPayload = {};
  let groups = 0;
  if (o.selection !== undefined) {
    out.selection = assertSelection(o.selection);
    groups += 1;
  }
  if (o.custom !== undefined) {
    out.custom = assertCustom(o.custom);
    groups += 1;
  }
  if (o.apiKey !== undefined && o.apiKey !== '') {
    const key = str(o.apiKey, 'apiKey', 512, false);
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f]/.test(key)) throw new Error('aiModelAccess.apiKey must not contain whitespace');
    out.apiKey = key;
    groups += 1;
  }
  if (groups === 0) throw new Error('aiModelAccess payload must contain at least one group');
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > AI_MODEL_ACCESS_MAX_BYTES) {
    throw new Error('aiModelAccess exceeds 32 KiB limit');
  }
  return out;
}
