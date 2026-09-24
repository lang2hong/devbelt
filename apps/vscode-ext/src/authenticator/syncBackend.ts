import type { EntityBackend, EntitySyncRecord, EntityValue } from '@devbelt/db-host/sync/e2e/entityStore';
import type { SyncEntityRef } from '@devbelt/db-host/sync/e2e/syncEntity';
import type { ChangeSource } from '@devbelt/db-host/connection/queryStore';
import type { AuthenticatorStore } from './store';
import type { AuthenticatorEntry, AuthenticatorGroup, AuthenticatorTag } from './types';

/**
 * P6：验证器同步实体后端（包装 `AuthenticatorStore`），供 db-host 的 `EntityStore`
 * 按类型分派（验证器三类）。契约（与 ConnectionStore 后端一致）：
 * - `listForSync()` **含墓碑**（`deleted:true`），供出站对账识别 delete；
 * - `save()` 后 `get()` 必须返回带数值 `updateTime` 的实体（对账/冲突依赖）；
 * - 条目 secret 经 `SecretStorage` 进出（`getEntryForSync`/`upsertFromSync`），不进 memento。
 */
export class AuthenticatorSyncBackend implements EntityBackend {
  constructor(private readonly store: AuthenticatorStore) {}

  listForSync(): EntitySyncRecord[] {
    const out: EntitySyncRecord[] = [];
    for (const e of this.store.listEntriesForSync()) {
      out.push({ ref: { type: 'authenticatorEntry', localId: e.id }, deleted: e.deleted === true, updateTime: e.updateTime });
    }
    for (const g of this.store.listGroupsForSync()) {
      out.push({ ref: { type: 'authenticatorGroup', localId: g.id }, deleted: g.deleted === true, updateTime: g.updateTime ?? 0 });
    }
    for (const t of this.store.listTagsForSync()) {
      out.push({ ref: { type: 'authenticatorTag', localId: t.id }, deleted: t.deleted === true, updateTime: t.updateTime ?? 0 });
    }
    return out;
  }

  get(ref: SyncEntityRef): EntityValue | undefined {
    switch (ref.type) {
      case 'authenticatorEntry': return this.store.getEntryForSync(ref.localId);
      case 'authenticatorGroup': return this.store.listGroupsForSync().find((g) => g.id === ref.localId);
      case 'authenticatorTag': return this.store.listTagsForSync().find((t) => t.id === ref.localId);
      default: return undefined;
    }
  }

  async save(ref: SyncEntityRef, entity: EntityValue, _source: ChangeSource): Promise<void> {
    switch (ref.type) {
      case 'authenticatorEntry': {
        const e = entity as AuthenticatorEntry & { secret?: string };
        if (!e.secret) throw new Error('authenticator entry sync requires secret');
        await this.store.upsertFromSync({ ...e, id: ref.localId }, e.secret);
        return;
      }
      case 'authenticatorGroup':
        await this.store.upsertGroupFromSync({ ...(entity as AuthenticatorGroup), id: ref.localId });
        return;
      case 'authenticatorTag':
        await this.store.upsertTagFromSync({ ...(entity as AuthenticatorTag), id: ref.localId });
        return;
      default:
        throw new Error(`authenticator backend cannot save entity type ${ref.type}`);
    }
  }

  async remove(ref: SyncEntityRef, _source: ChangeSource): Promise<void> {
    switch (ref.type) {
      case 'authenticatorEntry': return this.store.removeFromSync(ref.localId);
      case 'authenticatorGroup': return this.store.removeGroupFromSync(ref.localId);
      case 'authenticatorTag': return this.store.removeTagFromSync(ref.localId);
      default: return undefined;
    }
  }
}
