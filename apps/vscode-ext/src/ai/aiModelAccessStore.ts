import type { AiModelAccessFields, AiModelAccessSelection, AiModelAccessCustom } from '@devbelt/db-host/sync/e2e/aiModelAccessTypes';
import { DEFAULT_MODEL_ACCESS_PREFS, type ModelAccessSyncPrefs } from './modelAccess.js';
import { accountScope, scopedKey, scopedPrefix } from '../sync/accountScope';

/**
 * AI 模型接入配置的本地记录存储（同步实体 `aiModelAccess` 的本地真身）。
 *
 * - 记录式（含墓碑与 updateTime），键 `devbelt.ai.modelAccess.rec.<localId>`；
 * - **API Key 永不进 Memento**：记录只存选择/自定义两组字段，密钥只在 SecretStorage（AiKeyStore）；
 * - 同步项勾选是**本机**设置（`devbelt.ai.modelAccess.syncPrefs`，不随同步走）；
 * - 同一用户跨设备可能各自建出一条记录（首次同步前）：「有效配置」取未删除记录中 updateTime 最大者
 *   （最后写入者胜），旧记录留存无害。
 */
export const MODEL_ACCESS_RECORD_PREFIX = 'devbelt.ai.modelAccess.rec.';
const PREFS_KEY = 'devbelt.ai.modelAccess.syncPrefs';

/** 与 Memento 的最小交集（globalState 满足；测试可注入 fake）。 */
export interface ModelAccessMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
  keys(): readonly string[];
}

export type StoredModelAccessFields = AiModelAccessFields;

export interface ModelAccessRecord {
  id: string;
  fields: StoredModelAccessFields;
  updateTime: number;
  deleted?: boolean;
}

export const DEFAULT_MODEL_ACCESS_FIELDS: StoredModelAccessFields = {
  mode: 'server-proxy',
  vendorId: '',
  baseUrl: '',
  model: '',
  customVendors: [],
  customModels: {},
};

export class AiModelAccessStore {
  constructor(
    private readonly memento: ModelAccessMemento,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => `ma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  /** 账号作用域下的记录键前缀；未登录沿用旧前缀。 */
  private prefix(): string {
    return scopedPrefix(MODEL_ACCESS_RECORD_PREFIX);
  }

  private keyFor(id: string): string {
    return `${this.prefix()}${id}`;
  }

  /**
   * B1：首次在某个作用域下访问时，把旧（local）记录复制一份到该账号，原数据保留。
   * 每个作用域只做一次——同一次运行里 A→B 切换也要为 B 复制，不能只记「迁移过」。
   */
  private ensureMigrated(): void {
    const scope = accountScope();
    if (this.migratedFor === scope) return;
    this.migratedFor = scope;
    if (scope === 'local') return;
    for (const key of this.memento.keys()) {
      if (!key.startsWith(MODEL_ACCESS_RECORD_PREFIX)) continue;
      const rest = key.slice(MODEL_ACCESS_RECORD_PREFIX.length);
      if (!rest || rest.startsWith('u.')) continue;
      const target = this.keyFor(rest);
      if (this.memento.get(target) === undefined) void this.memento.update(target, this.memento.get(key));
    }
  }

  /** 已完成迁移的作用域（`local` 表示无需迁移）。 */
  private migratedFor?: string;

  listRecords(): ModelAccessRecord[] {
    this.ensureMigrated();
    const out: ModelAccessRecord[] = [];
    const prefix = this.prefix();
    // `local` 的前缀是通用的：`rec.u.<uid>.` 也以它开头，必须排除，
    // 否则未登录时会读到某个账号的模型配置。
    const skipScoped = accountScope() === 'local';
    for (const key of this.memento.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (skipScoped && key.slice(prefix.length).startsWith('u.')) continue;
      const rec = this.memento.get<ModelAccessRecord>(key);
      if (rec && typeof rec.id === 'string' && rec.fields) out.push(rec);
    }
    return out;
  }

  getRecord(id: string): ModelAccessRecord | undefined {
    this.ensureMigrated();
    return this.memento.get<ModelAccessRecord>(this.keyFor(id));
  }

  /** 有效配置记录：未删除中 updateTime 最大者。 */
  effective(): ModelAccessRecord | undefined {
    let best: ModelAccessRecord | undefined;
    for (const rec of this.listRecords()) {
      if (rec.deleted) continue;
      if (!best || rec.updateTime > best.updateTime) best = rec;
    }
    return best;
  }

  /** 有效配置（无记录 → 默认）。 */
  current(): StoredModelAccessFields {
    return this.effective()?.fields ?? DEFAULT_MODEL_ACCESS_FIELDS;
  }

  /** 同步项勾选（本机；缺省全开）。 */
  getPrefs(): ModelAccessSyncPrefs {
    const key = scopedKey(PREFS_KEY);
    let stored = this.memento.get<ModelAccessSyncPrefs>(key);
    // B1：账号作用域没有时回退旧键，并复制一份。
    if (stored === undefined && key !== PREFS_KEY) {
      const legacy = this.memento.get<ModelAccessSyncPrefs>(PREFS_KEY);
      if (legacy !== undefined) { stored = legacy; void this.memento.update(key, legacy); }
    }
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_MODEL_ACCESS_PREFS };
    return {
      selection: stored.selection !== false,
      custom: stored.custom !== false,
      key: stored.key !== false,
    };
  }

  async setPrefs(prefs: ModelAccessSyncPrefs): Promise<void> {
    await this.memento.update(scopedKey(PREFS_KEY), prefs);
  }

  /** 本地保存（用户显式操作）：更新有效记录，无则新建。 */
  async saveLocal(fields: StoredModelAccessFields): Promise<ModelAccessRecord> {
    const id = this.effective()?.id ?? this.newId();
    return this.write(id, fields);
  }

  /** 同步入站落地（写入时打点 updateTime，使其成为有效配置）。 */
  async saveRecord(id: string, fields: StoredModelAccessFields): Promise<ModelAccessRecord> {
    return this.write(id, fields);
  }

  /** 墓碑（跨设备删除传播）。 */
  async removeRecord(id: string): Promise<void> {
    const rec = this.getRecord(id);
    if (!rec) return;
    await this.memento.update(this.keyFor(id), { ...rec, deleted: true, updateTime: this.now() });
  }

  private async write(id: string, fields: StoredModelAccessFields): Promise<ModelAccessRecord> {
    const rec: ModelAccessRecord = { id, fields: stripKey(fields), updateTime: this.now() };
    await this.memento.update(this.keyFor(id), rec);
    return rec;
  }
}

/** 选择组字段（供合并工具）。 */
export function selectionOf(fields: StoredModelAccessFields): AiModelAccessSelection {
  return { mode: fields.mode, vendorId: fields.vendorId, baseUrl: fields.baseUrl, model: fields.model };
}

/** 自定义组字段（供合并工具）。 */
export function customOf(fields: StoredModelAccessFields): AiModelAccessCustom {
  return { customVendors: fields.customVendors, customModels: fields.customModels };
}

/** 防御：即便调用方误传 apiKey 也不落 Memento。 */
function stripKey(fields: StoredModelAccessFields): StoredModelAccessFields {
  const { apiKey: _drop, ...rest } = fields as StoredModelAccessFields & { apiKey?: unknown };
  return rest;
}
