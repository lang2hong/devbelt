import type { Memento, SecretStorage } from 'vscode';
import { diagInfo, diagWarn } from './diagnostics';

/**
 * 组织功能已移除：清理其遗留在 OS 密钥库的凭据。
 *
 * 旧 `CredentialVault` 以 `devbelt.org.credential.<orgId>.<resourceId>` 为键，把组织
 * 资源的连接凭据写入 `SecretStorage`，并在 `globalState` 的
 * `devbelt.org.credential.index` 里保存 key 列表。`SecretStorage` 无枚举接口，
 * 只能读旧 index 逐个删除。
 *
 * 幂等且自终止：全部删除成功后将 index 置空，之后每次激活读到空 index 立即 no-op；
 * 单条删除失败则保留在 index 里，下次激活重试。不抛错、不阻断扩展激活。
 */
const LEGACY_ORG_CREDENTIAL_PREFIX = 'devbelt.org.credential';
const LEGACY_ORG_CREDENTIAL_INDEX_KEY = 'devbelt.org.credential.index';

/** 真正的凭据 key 形如 `devbelt.org.credential.<orgId>.<resourceId>`（前缀后再含至少一个 `.`）。 */
function isLegacyOrgCredentialKey(key: string): boolean {
  const head = `${LEGACY_ORG_CREDENTIAL_PREFIX}.`;
  if (!key.startsWith(head)) return false;
  return key.slice(head.length).includes('.');
}

export async function purgeLegacyOrgCredentials(
  memento: Memento,
  secrets: SecretStorage,
): Promise<void> {
  const keys = memento.get<unknown>(LEGACY_ORG_CREDENTIAL_INDEX_KEY);
  if (!Array.isArray(keys) || keys.length === 0) return;

  const remaining: string[] = [];
  let removed = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || !isLegacyOrgCredentialKey(key)) continue;
    try {
      await secrets.delete(key);
      removed++;
    } catch (err) {
      remaining.push(key);
      diagWarn('legacy org credential cleanup: delete failed', String(err));
    }
  }
  await memento.update(LEGACY_ORG_CREDENTIAL_INDEX_KEY, remaining.length > 0 ? remaining : undefined);
  diagInfo('legacy org credential cleanup done', String({ removed, remaining: remaining.length }));
}
