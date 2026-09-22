/**
 * AuthenticatorStore — 条目/分组/标签的持久化层，对齐 CredentialVault 与 ConnectionStore 的模式：
 *
 * - **存储分离**：条目元数据（issuer/account/algorithm/digits/period/groupId/tags/timestamps）
 *   走 `context.globalState`（跨项目持久化，**不要**用 workspaceState）；
 *   TOTP secret 单独走 `vscode.SecretStorage`（OS Keychain），键形如
 *   `devbelt.authenticator.<id>.secret`。
 * - **secret 内存缓存（性能关键）**：SecretStorage 底层每次调用都是 OS IPC/Keychain
 *   调用，每秒对每条条目逐一打 Keychain 会把扩展宿主打挂；因此维护
 *   `secretCache: Map<id, normSecret>` 作为计算 TOTP 时的唯一读取源，
 *   `getCodes(entryIds, nowMs)` **禁止**直接调 `secrets.get()`，必须从 cache 读。
 * - **异步预热契约**：`async init()` 必须在构造 provider / 注册命令之前 await，
 *   批量从 SecretStorage 读 secret 填 cache；找不到的 id 记入 `missingSecrets`，
 *   snapshot 下发 `error:'secretMissing'`（UI 灰色条），**不**抛异常中断激活。
 * - **事务顺序（避免 orphan secret / 孤儿索引）**：
 *     deleteEntry: 先删 secret，成功后才改 memento；secret 删除失败直接返回，索引不动。
 *     addEntry: secret 写入成功后才加入 entries 数组 + 写 memento。
 * - **跨窗口同步**：订阅 `secrets.onDidChange`，必须先用 `parseSecretKey` 校验前缀
 *   再反解 entry id（其他模块的密钥变更要忽略），**不要**把 `e.key` 当作 cache key
 *   （cache key 是 entry id，不是完整 SecretStorage 路径），否则会产生脏条目。
 * - **配额**：业务错误（quota / invalidSecret / invalidField / notFound）用
 *   `{ ok:false, reason }` 结果对象返回，**不要抛错**——`makeSub` 会把抛出的异常
 *   兜底成通用"命令失败"对话框，丢失"升级 Pro"定制按钮。未登录态不限条数；
 *   已登录态上限 `0` 语义为**不限**（`limit > 0 && count >= limit`）。
 * - **事件**：所有写操作成功后 `eventBus.publish(new AuthenticatorChangedEvent(...))`，
 *   由 extension.ts 订阅并刷新 provider；Store 自身不直接通知 provider，保持解耦。
 * - **Disposable**：清理 onDidChange 订阅、清内存缓存；`context.subscriptions` 里
 *   provider 之前 push，反序 dispose 时 provider 先销毁。
 *
 * 实现依赖：`@devbelt/db-host/utils/id` 的 `uniqueId(prefix)`（前缀 `ae`/`ag`/`at`）；
 * 全局 `eventBus` 单例。本文件 vscode 依赖仅用 `import type`，日志走注入的 StoreLogger，
 * 以保持 vitest 可测（测试环境无 `vscode` 包）。
 */

import type { Memento, SecretStorage, Disposable as VscodeDisposable } from 'vscode';
import { uniqueId } from '@devbelt/db-host/utils/id';
import { eventBus } from '@devbelt/db-host/utils/event';
import type { CachedEntitlement } from '@devbelt/db-host/sync/entitlementGate';
import { maxAuthenticatorEntries } from '@devbelt/db-host/sync/entitlementGate';
import { canonicalizeSecret, totpFromSecret } from './totp';
import { buildOtpauthUri } from './otpauth';
import { AuthenticatorChangedEvent } from './events';
import {
  type AuthenticatorEntry,
  type AuthenticatorGroup,
  type AuthenticatorTag,
  type TotpAlgorithm,
  type TagColorKey,
  AUTHENTICATOR_TAG_COLORS,
  ENTRIES_KEY,
  GROUPS_KEY,
  TAGS_KEY,
  secretKey,
  parseSecretKey,
} from './types';

/**
 * 最小日志句柄——默认走 console，extension.ts 换成 diagnostics 通道，
 * 避免 store 直接依赖 vscode 输出通道（否则 vitest 因找不到 `vscode` 包无法跑）。
 */
export interface StoreLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const consoleLogger: StoreLogger = {
  info: (m, ...a) => console.info(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

/** 注入的权益读取句柄——现场读取，**不要**在构造时拍 snapshot，否则登录/登出/套餐变更后永远是旧值。 */
export interface AuthenticatorStoreDeps {
  isLoggedIn(): boolean;
  getCachedEntitlement(): CachedEntitlement | undefined;
}

export type AddResult =
  | { ok: true; entry: AuthenticatorEntry }
  | { ok: false; reason: 'quota'; limit: number }
  | { ok: false; reason: 'invalidSecret'; field?: string }
  | { ok: false; reason: 'invalidField'; field: string }
  | { ok: false; reason: 'storageError'; message?: string };

export type UpdateResult =
  | { ok: true; entry: AuthenticatorEntry }
  | { ok: false; reason: 'invalidSecret' | 'invalidField' | 'notFound' | 'storageError' };

export type RenameResult =
  | { ok: true }
  | { ok: false; reason: 'invalidName' | 'notFound' };

export type GroupAddResult =
  | { ok: true; group: AuthenticatorGroup }
  | { ok: false; reason: 'invalidName' };

export type TagAddResult =
  | { ok: true; tag: AuthenticatorTag }
  | { ok: false; reason: 'invalidName' | 'invalidColor' };

export interface CodeResult {
  code: string;
  secondsLeft: number;
}

/** IPC null/'' → 持久化 undefined；未分组无持久化记录。 */
function normalizeGroupId(gid: string | null | undefined): string | undefined {
  if (gid === null || gid === '') return undefined;
  return gid;
}

function isTotpAlgorithm(a: string): a is TotpAlgorithm {
  return a === 'SHA1' || a === 'SHA256' || a === 'SHA512';
}

function clampDigits(d: number): 6 | 8 {
  return d === 8 ? 8 : 6;
}

function clampPeriod(p: number): 30 | 60 {
  return p === 60 ? 60 : 30;
}

export class AuthenticatorStore implements VscodeDisposable {
  private initialized = false;
  private entries: AuthenticatorEntry[] = [];
  private groups: AuthenticatorGroup[] = [];
  private tags: AuthenticatorTag[] = [];
  /** secret 运行期内存缓存：id → 规范化后的大写无 padding base32 字符串；getCodes 只读它。 */
  private readonly secretCache = new Map<string, string>();
  /** init 时未能从 SecretStorage 取到的 id（用户手动清 Keychain / 迁移残留等场景）。 */
  private readonly missingSecrets = new Set<string>();
  private secretEventsSub?: VscodeDisposable;

  constructor(
    private readonly memento: Memento,
    private readonly secrets: SecretStorage,
    private readonly auth: AuthenticatorStoreDeps,
    private readonly log: StoreLogger = consoleLogger,
  ) {}

  /**
   * 异步预热：批量读 SecretStorage 填 secretCache，找不到的 id 记 missingSecrets。
   * 必须在 provider / 命令注册之前 await 完成；不抛异常中断激活。
   */
  async init(): Promise<void> {
    this.entries = this.memento.get<AuthenticatorEntry[]>(ENTRIES_KEY) ?? [];
    this.groups = this.memento.get<AuthenticatorGroup[]>(GROUPS_KEY) ?? [];
    this.tags = this.memento.get<AuthenticatorTag[]>(TAGS_KEY) ?? [];
    this.secretCache.clear();
    this.missingSecrets.clear();
    await Promise.all(this.entries.map(async (e) => {
      try {
        const v = await this.secrets.get(secretKey(e.id));
        if (v === undefined) this.missingSecrets.add(e.id);
        else this.secretCache.set(e.id, v);
      } catch (err) {
        // 单条失败不阻断整批预热，标记为缺失由 UI 显示灰色条
        this.log.warn('authenticator secret preload failed', String(err));
        this.missingSecrets.add(e.id);
      }
    }));
    // 跨窗口密钥变更：用 parseSecretKey 校验前缀，合法才更新 cache 并 publish 事件
    this.secretEventsSub = this.secrets.onDidChange((e) => {
      const id = parseSecretKey(e.key);
      if (id === null) return;
      void (async () => {
        try {
          const v = await this.secrets.get(e.key);
          if (v === undefined) {
            this.secretCache.delete(id);
            this.missingSecrets.add(id);
          } else {
            this.secretCache.set(id, v);
            this.missingSecrets.delete(id);
          }
          await eventBus.publish(new AuthenticatorChangedEvent('entry', 'update', id));
        } catch (err) {
          this.log.warn('authenticator onDidChange refresh failed', String(err));
        }
      })();
    });
    this.initialized = true;
  }

  private assertInit(): void {
    if (!this.initialized) throw new Error('store not initialized');
  }

  listEntries(): readonly AuthenticatorEntry[] { this.assertInit(); return this.entries; }
  listGroups(): readonly AuthenticatorGroup[] { this.assertInit(); return this.groups; }
  listTags(): readonly AuthenticatorTag[] { this.assertInit(); return this.tags; }

  /** 从 cache 取规范化 secret；cache miss 或已标记 missing 返回 undefined。 */
  getSecret(id: string): string | undefined {
    this.assertInit();
    if (this.missingSecrets.has(id)) return undefined;
    return this.secretCache.get(id);
  }

  isSecretMissing(id: string): boolean {
    this.assertInit();
    return this.missingSecrets.has(id);
  }

  // memento 写入封装：所有写操作最终走这些函数，便于将来加 diff/审计。
  private async saveEntries(): Promise<void> { await this.memento.update(ENTRIES_KEY, this.entries); }
  private async saveGroups(): Promise<void> { await this.memento.update(GROUPS_KEY, this.groups); }
  private async saveTags(): Promise<void> { await this.memento.update(TAGS_KEY, this.tags); }

  private publish(kind: 'entry' | 'group' | 'tag', op: 'create' | 'update' | 'delete', id: string): void {
    void eventBus.publish(new AuthenticatorChangedEvent(kind, op, id));
  }

  async addEntry(input: {
    issuer: string;
    account?: string;
    secret: string;
    algorithm?: TotpAlgorithm;
    digits?: 6 | 8;
    period?: 30 | 60;
    groupId?: string | null;
    tags?: string[];
  }): Promise<AddResult> {
    this.assertInit();
    // 空 secret（''/纯空白/纯 '='）会被 canonicalizeSecret 解成空串——不是有效密钥，必须拒绝，
    // 否则会写入一个空 Keychain 项并产出确定性错码。
    let canonicalSecret: string;
    try {
      canonicalSecret = canonicalizeSecret(input.secret);
    } catch {
      return { ok: false, reason: 'invalidSecret', field: 'secret' };
    }
    if (!canonicalSecret) return { ok: false, reason: 'invalidSecret', field: 'secret' };
    const algorithm = (input.algorithm ?? 'SHA1') as TotpAlgorithm;
    if (!isTotpAlgorithm(algorithm)) return { ok: false, reason: 'invalidField', field: 'algorithm' };
    // 登录态配额预检：未登录不限；0 表示不限；超限直接返回（不抛错，不展开表单）
    if (this.auth.isLoggedIn()) {
      const limit = maxAuthenticatorEntries(this.auth.getCachedEntitlement());
      if (limit > 0 && this.entries.length >= limit) return { ok: false, reason: 'quota', limit };
    }
    const groupId = normalizeGroupId(input.groupId);
    if (groupId !== undefined && !this.groups.some((g) => g.id === groupId)) {
      return { ok: false, reason: 'invalidField', field: 'groupId' };
    }
    const tagIds = input.tags ?? [];
    for (const tid of tagIds) {
      if (!this.tags.some((t) => t.id === tid)) return { ok: false, reason: 'invalidField', field: 'tags' };
    }
    const id = uniqueId('ae');
    const now = Date.now();
    const entry: AuthenticatorEntry = {
      id,
      issuer: input.issuer,
      account: input.account,
      algorithm,
      digits: clampDigits(input.digits ?? 6),
      period: clampPeriod(input.period ?? 30),
      groupId,
      tags: tagIds,
      createTime: now,
      updateTime: now,
    };
    // 事务顺序：先写 secret，成功后才动 memento——secret 写失败不产生孤儿索引
    try {
      await this.secrets.store(secretKey(id), canonicalSecret);
    } catch (err) {
      this.log.error('authenticator add secret storage failed', String(err));
      return { ok: false, reason: 'storageError', message: String(err) };
    }
    this.secretCache.set(id, canonicalSecret);
    this.missingSecrets.delete(id);
    this.entries.push(entry);
    await this.saveEntries();
    this.publish('entry', 'create', id);
    return { ok: true, entry };
  }

  async updateEntry(id: string, patch: {
    issuer?: string;
    account?: string;
    secret?: string;
    algorithm?: TotpAlgorithm;
    digits?: 6 | 8;
    period?: 30 | 60;
    groupId?: string | null;
    tags?: string[];
  }): Promise<UpdateResult> {
    this.assertInit();
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, reason: 'notFound' };
    const prev = this.entries[idx];
    let newSecret: string | undefined;
    if (patch.secret !== undefined) {
      try { newSecret = canonicalizeSecret(patch.secret); }
      catch { return { ok: false, reason: 'invalidSecret' }; }
      if (!newSecret) return { ok: false, reason: 'invalidSecret' };
    }
    let groupId = prev.groupId;
    if (patch.groupId !== undefined) {
      groupId = normalizeGroupId(patch.groupId);
      if (groupId !== undefined && !this.groups.some((g) => g.id === groupId)) {
        return { ok: false, reason: 'invalidField' };
      }
    }
    if (patch.algorithm !== undefined && !isTotpAlgorithm(patch.algorithm)) {
      return { ok: false, reason: 'invalidField' };
    }
    let tags = prev.tags;
    if (patch.tags !== undefined) {
      for (const tid of patch.tags) {
        if (!this.tags.some((t) => t.id === tid)) return { ok: false, reason: 'invalidField' };
      }
      tags = patch.tags;
    }
    if (newSecret !== undefined) {
      try {
        await this.secrets.store(secretKey(id), newSecret);
      } catch (err) {
        this.log.error('authenticator update secret storage failed', String(err));
        return { ok: false, reason: 'storageError' };
      }
      this.secretCache.set(id, newSecret);
      this.missingSecrets.delete(id);
    }
    const next: AuthenticatorEntry = {
      ...prev,
      issuer: patch.issuer ?? prev.issuer,
      account: patch.account ?? prev.account,
      algorithm: patch.algorithm ?? prev.algorithm,
      // 入站 patch 可能是未类型校验的 IPC 数据，这里与 addEntry 一样做 clamp
      digits: clampDigits(patch.digits ?? prev.digits),
      period: clampPeriod(patch.period ?? prev.period),
      groupId,
      tags,
      updateTime: Date.now(),
    };
    this.entries[idx] = next;
    await this.saveEntries();
    this.publish('entry', 'update', id);
    return { ok: true, entry: next };
  }

  async deleteEntry(id: string): Promise<{ ok: boolean; reason?: string }> {
    this.assertInit();
    // 事务顺序：先删 secret，成功后再改 memento；secret 删除失败索引不动，避免 orphan secret
    try {
      await this.secrets.delete(secretKey(id));
    } catch (err) {
      this.log.error('authenticator delete secret failed', String(err));
      return { ok: false, reason: 'storageError' };
    }
    this.secretCache.delete(id);
    this.missingSecrets.delete(id);
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.saveEntries();
    this.publish('entry', 'delete', id);
    return { ok: true };
  }

  async addGroup(name: string, afterId?: string): Promise<GroupAddResult> {
    this.assertInit();
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'invalidName' };
    // 默认 sortOrder = 当前最大 + 10，留空隙方便 drag 重排；若指定 afterId 则插在后面，
    // 空隙不足（<2）时先重写为 10,20,30... 再插，避免 sortOrder 重叠/浮点。
    let sortOrder: number;
    if (afterId !== undefined) {
      const after = this.groups.find((g) => g.id === afterId);
      if (after) {
        const idx = this.groups.indexOf(after);
        const next = this.groups[idx + 1];
        const afterOrder = after.sortOrder;
        const nextOrder = next ? next.sortOrder : afterOrder + 20;
        sortOrder = (afterOrder + nextOrder) / 2;
        if (sortOrder === afterOrder || sortOrder === nextOrder || (nextOrder - afterOrder) < 2) {
          this.rewriteGroupOrders();
          const after2 = this.groups.find((g) => g.id === afterId);
          sortOrder = after2 ? after2.sortOrder + 5 : this.groups.reduce((m, g) => Math.max(m, g.sortOrder), 0) + 10;
        }
      } else {
        sortOrder = this.groups.reduce((m, g) => Math.max(m, g.sortOrder), 0) + 10;
      }
    } else {
      sortOrder = this.groups.reduce((m, g) => Math.max(m, g.sortOrder), 0) + 10;
    }
    const group: AuthenticatorGroup = { id: uniqueId('ag'), name: trimmed, sortOrder };
    this.groups.push(group);
    this.groups.sort((a, b) => a.sortOrder - b.sortOrder);
    await this.saveGroups();
    this.publish('group', 'create', group.id);
    return { ok: true, group };
  }

  async renameGroup(id: string, name: string): Promise<RenameResult> {
    this.assertInit();
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'invalidName' };
    const g = this.groups.find((x) => x.id === id);
    if (!g) return { ok: false, reason: 'notFound' };
    g.name = trimmed;
    await this.saveGroups();
    this.publish('group', 'update', id);
    return { ok: true };
  }

  /** 删分组时该组下条目 groupId 置 undefined（回落到未分组），不制造合成默认组。 */
  async deleteGroup(id: string): Promise<{ ok: boolean }> {
    this.assertInit();
    if (!this.groups.some((g) => g.id === id)) return { ok: false };
    this.groups = this.groups.filter((g) => g.id !== id);
    let changed = false;
    for (const e of this.entries) {
      if (e.groupId === id) {
        e.groupId = undefined;
        e.updateTime = Date.now();
        changed = true;
      }
    }
    await Promise.all([this.saveGroups(), changed ? this.saveEntries() : Promise.resolve()]);
    this.publish('group', 'delete', id);
    if (changed) this.publish('entry', 'update', '*');
    return { ok: true };
  }

  /** 按传入 id 顺序把 groups 的 sortOrder 重写为 10,20,30,...，避免空隙/重叠。 */
  async reorderGroup(orderedIds: string[]): Promise<void> {
    this.assertInit();
    orderedIds.forEach((id, idx) => {
      const g = this.groups.find((x) => x.id === id);
      if (g) g.sortOrder = (idx + 1) * 10;
    });
    this.groups.sort((a, b) => a.sortOrder - b.sortOrder);
    await this.saveGroups();
    this.publish('group', 'update', '*');
  }

  private rewriteGroupOrders(): void {
    this.groups.forEach((g, i) => { g.sortOrder = (i + 1) * 10; });
  }

  async addTag(name: string, color: TagColorKey): Promise<TagAddResult> {
    this.assertInit();
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'invalidName' };
    // color 必须是 AUTHENTICATOR_TAG_COLORS 白名单值，非白名单拒绝（避免把脏 hex 写进 memento）
    if (!AUTHENTICATOR_TAG_COLORS.includes(color)) return { ok: false, reason: 'invalidColor' };
    const tag: AuthenticatorTag = { id: uniqueId('at'), name: trimmed, color };
    this.tags.push(tag);
    await this.saveTags();
    this.publish('tag', 'create', tag.id);
    return { ok: true, tag };
  }

  async renameTag(id: string, name: string): Promise<RenameResult> {
    this.assertInit();
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'invalidName' };
    const t = this.tags.find((x) => x.id === id);
    if (!t) return { ok: false, reason: 'notFound' };
    t.name = trimmed;
    await this.saveTags();
    this.publish('tag', 'update', id);
    return { ok: true };
  }

  async recolorTag(id: string, color: TagColorKey): Promise<{ ok: boolean; reason?: string }> {
    this.assertInit();
    if (!AUTHENTICATOR_TAG_COLORS.includes(color)) return { ok: false, reason: 'invalidColor' };
    const t = this.tags.find((x) => x.id === id);
    if (!t) return { ok: false, reason: 'notFound' };
    t.color = color;
    await this.saveTags();
    this.publish('tag', 'update', id);
    return { ok: true };
  }

  /** 删 tag 时从所有 entry.tags 中移除该 id，避免 tag 被删后 entry 里留孤儿 id。 */
  async deleteTag(id: string): Promise<{ ok: boolean }> {
    this.assertInit();
    if (!this.tags.some((t) => t.id === id)) return { ok: false };
    this.tags = this.tags.filter((t) => t.id !== id);
    let changed = false;
    for (const e of this.entries) {
      const before = e.tags.length;
      e.tags = e.tags.filter((tid) => tid !== id);
      if (e.tags.length !== before) {
        e.updateTime = Date.now();
        changed = true;
      }
    }
    await Promise.all([this.saveTags(), changed ? this.saveEntries() : Promise.resolve()]);
    this.publish('tag', 'delete', id);
    if (changed) this.publish('entry', 'update', '*');
    return { ok: true };
  }

  /**
   * 计算指定条目的 TOTP code。**只从 secretCache 读**，不碰 secrets API；
   * cache miss / missingSecrets 的 id 不出现在返回结果里（snapshot 里已标 error）。
   * 单趟遍历 entries、用请求 id 的 Set 过滤：无整表 Map 重建、无索引失效面，
   * 每秒热路径上只做 O(n) 廉价判断（Pro 上限 1000 条亦无压力）。
   */
  getCodes(entryIds: readonly string[], nowMs: number): Record<string, CodeResult> {
    this.assertInit();
    const out: Record<string, CodeResult> = {};
    const wanted = new Set(entryIds);
    for (const e of this.entries) {
      if (!wanted.has(e.id)) continue;
      if (this.missingSecrets.has(e.id)) continue;
      const secret = this.secretCache.get(e.id);
      if (secret === undefined) continue;
      try {
        out[e.id] = totpFromSecret(secret, nowMs, e.period, e.digits, e.algorithm);
      } catch (err) {
        this.log.warn('authenticator totp compute failed', String(err));
      }
    }
    return out;
  }

  /**
   * 导出 otpauth URI 文本（CRLF 换行）；secret 统一为大写无空格无 padding 规范形态；
   * missingSecrets 的条目跳过（secret 丢失无法恢复，导出只会误导用户）。
   */
  exportAll(): string {
    this.assertInit();
    const lines: string[] = [];
    for (const e of this.entries) {
      if (this.missingSecrets.has(e.id)) continue;
      const secret = this.secretCache.get(e.id);
      if (secret === undefined) continue;
      lines.push(buildOtpauthUri({
        issuer: e.issuer,
        account: e.account,
        secret,
        algorithm: e.algorithm,
        digits: e.digits,
        period: e.period,
      }));
    }
    return lines.length ? `${lines.join('\r\n')}\r\n` : '';
  }

  /**
   * 容错清空：遍历 entries 逐个删 secret，成功的从 cache 和 entries 移除，
   * 失败的保留在 memento 里下次重试（对齐 CredentialVault 模式，不丢索引不产生 orphan secret）。
   * **仅当全部成功**才清空 groups/tags——否则保留 groups/tags，使滞留条目的
   * groupId/tags 仍是有效引用，不制造悬挂指针。
   */
  async clearAll(): Promise<{ failed: string[] }> {
    this.assertInit();
    const remainingEntries: AuthenticatorEntry[] = [];
    const failed: string[] = [];
    for (const e of this.entries) {
      try {
        await this.secrets.delete(secretKey(e.id));
        this.secretCache.delete(e.id);
        this.missingSecrets.delete(e.id);
      } catch (err) {
        this.log.warn('authenticator clearAll delete secret failed', e.id);
        failed.push(e.id);
        remainingEntries.push(e);
      }
    }
    this.entries = remainingEntries;
    const allCleared = failed.length === 0;
    if (allCleared) {
      this.groups = [];
      this.tags = [];
    }
    await Promise.all([this.saveEntries(), this.saveGroups(), this.saveTags()]);
    this.log.info('authenticator clearAll done', String({ remaining: failed.length }));
    this.publish('entry', 'delete', '*');
    if (allCleared) {
      this.publish('group', 'delete', '*');
      this.publish('tag', 'delete', '*');
    }
    return { failed };
  }

  dispose(): void {
    this.secretEventsSub?.dispose();
    this.secretEventsSub = undefined;
    this.secretCache.clear();
    this.missingSecrets.clear();
  }
}
