import type { EntityBackend, EntitySyncRecord, EntityValue } from '@devbelt/db-host/sync/e2e/entityStore';
import type { SyncEntityRef } from '@devbelt/db-host/sync/e2e/syncEntity';
import type { SyncAiModelAccessValue, AiModelAccessFields, AiModelAccessPayload } from '@devbelt/db-host/sync/e2e/aiModelAccessTypes';
import {
  AiModelAccessStore,
  DEFAULT_MODEL_ACCESS_FIELDS,
  customOf,
  selectionOf,
  type StoredModelAccessFields,
} from './aiModelAccessStore.js';

/** 密钥面（AiKeyStore 结构性满足；Key 只在 SecretStorage）。 */
export interface ModelAccessKeyPort {
  /** 同步读取已缓存的 Key（未加载返回 undefined → 本次出站不带 Key，各端保留本机已有）。 */
  peekApiKey(): string | undefined;
  setApiKey(key: string): Promise<void>;
  hasApiKey(): Promise<boolean>;
}

export interface ModelAccessBackendHooks {
  /** 配置变化（本地保存或入站合并成为有效配置）后，落到运行时设置（provider/baseUrl/model）。 */
  applyRuntime(fields: StoredModelAccessFields): Promise<void>;
  /** 自带 Key 模式但本机没有 Key → 提示用户输入（配置已同步，Key 未到）。 */
  onNeedsKey?(): void;
}

/**
 * aiModelAccess 实体的宿主后端（镜像 SchemaNotesSyncBackend 模式）。
 *
 * **选择性同步（本机勾选，双向生效）**：
 * - 出站 `get`：只带本机勾选的组（selection/custom/apiKey）；
 * - 入站 `save`：按组**合并**——本机关闭该项或 payload 缺省时保留本机值；
 *   payload 带 Key 且本机勾选「同步 Key」才写 SecretStorage，否则**保留本机已有 Key**
 *   （不会因对端关闭同步而清空本机 Key）。
 */
export class ModelAccessSyncBackend implements EntityBackend {
  constructor(
    private readonly store: AiModelAccessStore,
    private readonly keys: ModelAccessKeyPort,
    private readonly hooks: ModelAccessBackendHooks,
  ) {}

  listForSync(): EntitySyncRecord[] {
    return this.store.listRecords().map((rec) => ({
      ref: { type: 'aiModelAccess', localId: rec.id },
      deleted: rec.deleted === true,
      updateTime: rec.updateTime,
    }));
  }

  get(ref: SyncEntityRef): EntityValue | undefined {
    const rec = this.store.getRecord(ref.localId);
    if (!rec) return undefined;
    const prefs = this.store.getPrefs();
    const value: SyncAiModelAccessValue = {
      id: rec.id,
      ...(prefs.selection ? { selection: selectionOf(rec.fields) } : {}),
      ...(prefs.custom ? { custom: customOf(rec.fields) } : {}),
      ...(prefs.key ? { apiKey: this.keys.peekApiKey() } : {}),
      updateTime: rec.updateTime,
      ...(rec.deleted ? { deleted: true } : {}),
    };
    return value;
  }

  async save(ref: SyncEntityRef, entity: EntityValue): Promise<void> {
    const incoming = entity as SyncAiModelAccessValue & Partial<AiModelAccessPayload>;
    const prefs = this.store.getPrefs();
    const current: AiModelAccessFields = this.store.getRecord(ref.localId)?.fields ?? this.store.current() ?? DEFAULT_MODEL_ACCESS_FIELDS;

    // 按组合并：本机勾选且 payload 携带才覆盖；否则保留本机值。
    const selection = prefs.selection && incoming.selection ? incoming.selection : selectionOf(current);
    const custom = prefs.custom && incoming.custom ? incoming.custom : customOf(current);
    const merged: StoredModelAccessFields = { ...selection, ...custom };

    await this.store.saveRecord(ref.localId, merged);
    if (this.store.effective()?.id !== ref.localId) return;

    await this.hooks.applyRuntime(merged);
    if (prefs.key && incoming.apiKey) await this.keys.setApiKey(incoming.apiKey);
    if (merged.mode === 'openai-compatible' && !(await this.keys.hasApiKey())) this.hooks.onNeedsKey?.();
  }

  async remove(ref: SyncEntityRef): Promise<void> {
    await this.store.removeRecord(ref.localId);
  }
}
