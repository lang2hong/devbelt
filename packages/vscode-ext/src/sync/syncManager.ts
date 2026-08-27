import * as crypto from 'crypto';
import { ConnectionStore } from '../connection/connectionStore';
import { HistoryStore } from '../history/historyStore';
import { AuthService } from './authService';
import { Encryption, MasterPasswordError } from './encryption';
import { parseSyncPayload, type SyncPayload } from './syncPayload';
import { computeMergePlan, totalLocalOnly, type MergePlan } from './mergePlan';
import { MasterPasswordStore } from './masterPasswordStore';
import { SyncEvent, eventBus } from '../utils/event';
import { DeviceLimitExceededError, ProFeatureRequiredError, QuotaExceededError, type PullResult } from './syncClient';

interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

export class SyncLocalDirtyError extends Error {
  constructor() {
    super('local has unpushed changes');
    this.name = 'SyncLocalDirtyError';
  }
}

/** 同步分节（与 server SectionType 对齐） */
const SECTION_TYPES = ['groups', 'connections', 'queries', 'folders', 'history'] as const;
type SectionType = (typeof SECTION_TYPES)[number];

/** 应用远端数据的策略：remote=远端覆盖本地；local=保留本地；merge=智能合并 */
export type ApplyStrategy = 'remote' | 'local' | 'merge';

/** 从完整 payload 取某节的原始数据 */
function sectionDataOf(payload: SyncPayload, section: SectionType): unknown {
  switch (section) {
    case 'groups': return payload.groups;
    case 'connections': return payload.connections;
    case 'queries': return payload.queries;
    case 'folders': return payload.queryFolders;
    case 'history': return payload.history;
  }
}

/**
 * 递归键排序序列化，用于内容指纹。
 *
 * 不能用 `JSON.stringify(payload, Object.keys(payload).sort())`：第二参数是
 * **replacer 白名单**而非排序器，只有顶层键（version/groups/connections…）在名单里，
 * 嵌套字段（name/host/password/sql…）会被整体剔除，序列化结果退化成
 * `{"connections":[{}],…}` —— 改任何连接内容指纹都不变，`isLocalDirty()` 恒为 false，
 * pull 的「本地有未推送变更」保护随之失效。
 *
 * 这里显式递归并对对象键排序，保证「同内容同指纹、异内容异指纹」。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => {
      const v = (value as Record<string, unknown>)[key];
      // 与 JSON.stringify 对齐：undefined 值的键整体省略
      return v === undefined ? undefined : `${JSON.stringify(key)}:${stableStringify(v)}`;
    })
    .filter((s): s is string => s !== undefined);
  return `{${entries.join(',')}}`;
}

/** 将某节解析结果写回 payload 对应字段 */
function assignSection(payload: any, section: string, data: unknown): void {
  switch (section) {
    case 'groups': payload.groups = data; break;
    case 'connections': payload.connections = data; break;
    case 'queries': payload.queries = data; break;
    case 'folders': payload.queryFolders = data; break;
    case 'history': payload.history = data; break;
  }
}

/**
 * 同步管理器：分节存储（方案 A）协调 认证 + 加密 + 数据拉取/推送。
 *  - push：payload 按节拆分 → 各自加密 → pushSection（乐观锁 + 配额由 server 校验）
 *  - pull：fetchSections → 各自解密 → 组装 payload → 合并（删除优先 / 最新 updateTime 胜）
 *  - 历史回滚：listVersions / rollback 透传 SyncClient
 *  端到端加密：server 仅见密文，合并/解密在本地。
 */
export class SyncManager {
  private static readonly LAST_HASH_KEY = 'dbclient.sync.lastHash';
  private static readonly LAST_SYNC_AT_KEY = 'dbclient.sync.lastSyncAt';
  /** 各 section 当前远端 version（乐观锁 baseVersion） */
  private sectionVersions: Partial<Record<SectionType, number>> = {};
  /** 预览拉取时缓存的远端解密 payload，供 applyPreviewedPull 直接合并 */
  private pendingRemote?: SyncPayload;

  constructor(
    private readonly auth: AuthService,
    private readonly store: ConnectionStore,
    private readonly history: HistoryStore,
    private readonly hashStore: MementoLike,
    private readonly masterPasswordStore: MasterPasswordStore,
    private readonly onDeviceLimit?: (err: Error) => void,
  ) {}

  private deviceLimitNotifiedAt = 0;
  /** 设备超限/付费功能引导：60s 去重；通知由构造注入的 onDeviceLimit 回调处理（避免本类依赖 vscode） */
  guideDeviceLimit(err: unknown): void {
    if (!(err instanceof DeviceLimitExceededError || err instanceof ProFeatureRequiredError || err instanceof QuotaExceededError)) return;
    const now = Date.now();
    if (now - this.deviceLimitNotifiedAt < 60_000) return;
    this.deviceLimitNotifiedAt = now;
    this.onDeviceLimit?.(err as Error);
  }

  /** fetchSections 包装：识别设备超限/付费功能并引导，其余错误透传 */
  private async fetchSectionsGuarded(section?: string): Promise<PullResult> {
    try {
      return await this.auth.client.fetchSections(section);
    } catch (err) {
      this.guideDeviceLimit(err);
      throw err;
    }
  }

  async pull(masterPassword: string, force = false): Promise<void> {
    if (!force) {
      if (await this.isLocalDirty()) throw new SyncLocalDirtyError();
    }
    try {
      const result = await this.fetchSectionsGuarded();
      const payload = await this.decryptSections(result.sections, masterPassword);
      await this.applyRemote(payload);
      if (!force) {
        await this.updateLastSyncHash();
      }
      // SyncEvent 此前只有类型定义、从无发布点
      void eventBus.publish(new SyncEvent('pull', `${result.sections.length} section(s)`));
    } catch (err) {
      void eventBus.publish(new SyncEvent('error', `pull failed: ${(err as Error).message}`));
      throw err;
    }
  }

  async push(masterPassword: string): Promise<void> {
    try {
      const payload = await this.buildLocalPayload();
      for (const section of SECTION_TYPES) {
        const data = sectionDataOf(payload, section);
        // 异步派生：600k 轮 PBKDF2 × 5 个 section，同步版会冻结扩展主进程数秒
        const enc = await Encryption.encryptAsync(data, masterPassword);
        const base = this.sectionVersions[section] ?? 0;
        const itemCount = this.itemCountOf(section, payload);
        const meta = section === 'connections' ? this.store.getConnectionMeta() : undefined;
        const { version } = await this.auth.client.pushSection(section, enc, base, itemCount, meta);
        this.sectionVersions[section] = version;
      }
      await this.updateLastSyncHash();
      void eventBus.publish(new SyncEvent('push', `${SECTION_TYPES.length} section(s)`));
    } catch (err) {
      this.guideDeviceLimit(err);
      void eventBus.publish(new SyncEvent('error', `push failed: ${(err as Error).message}`));
      throw err;
    }
  }

  /** 强制推送：先拉远端 versions 作 base，避免冲突，再推本地 */
  async forcePush(masterPassword: string): Promise<void> {
    const result = await this.fetchSectionsGuarded();
    for (const sec of result.sections) {
      this.sectionVersions[sec.section as SectionType] = sec.version;
    }
    await this.push(masterPassword);
  }

  async isLocalDirty(): Promise<boolean> {
    const last = this.hashStore.get<string>(SyncManager.LAST_HASH_KEY);
    if (!last) return false;
    return (await this.computeLocalHash()) !== last;
  }

  async previewPull(masterPassword: string): Promise<MergePlan> {
    const result = await this.fetchSectionsGuarded();
    const remote = await this.decryptSections(result.sections, masterPassword);
    this.pendingRemote = remote;
    const local = await this.buildLocalPayload();
    const plan = computeMergePlan(local, remote);
    const hasLocalUnpushed = (await this.isLocalDirty()) || totalLocalOnly(plan) > 0;
    return { ...plan, hasLocalUnpushed };
  }

  /** push 前的差异预览：与 previewPull 同源（fetch + 解密 + 计划），语义上仅命名区分 */
  async previewPush(masterPassword: string): Promise<MergePlan> {
    return this.previewPull(masterPassword);
  }

  async applyPreviewedPull(strategy: ApplyStrategy = 'merge'): Promise<void> {
    if (!this.pendingRemote) throw new Error('no previewed remote data to apply');
    const remote = this.pendingRemote;
    if (strategy !== 'local') {
      await this.applyRemote(remote, strategy);
    }
    this.pendingRemote = undefined;
    // local 策略保留本地现状、不应用远端，也不更新同步基线 —— 保持 local dirty，
    // 这样用户后续 push 才能把本地作为权威源覆盖远端。
    if (strategy !== 'local') {
      await this.updateLastSyncHash();
    }
    void eventBus.publish(new SyncEvent('applied', `previewed pull applied (${strategy})`));
  }

  /** 列某节历史版本 */
  async listVersions(section: string): Promise<Array<{ version: number; dataBytes: number; createTime: string }>> {
    return this.auth.client.listVersions(section);
  }

  /** 回滚某节到指定版本 */
  async rollback(section: string, toVersion: number, masterPassword: string): Promise<void> {
    await this.auth.client.rollback(section, toVersion);
    // 回滚后刷新本地该节
    const result = await this.fetchSectionsGuarded(section);
    if (result.sections.length) {
      const payload = await this.decryptSections(result.sections, masterPassword);
      await this.applyRemote(payload);
    }
  }

  getLastSyncAt(): number {
    return this.hashStore.get<number>(SyncManager.LAST_SYNC_AT_KEY) ?? 0;
  }

  /**
   * 自动同步一轮。
   *
   * 返回值决定调用方的处置（见 AutoSyncService）：`error` 会**退避重试直到
   * 成功**，`no-master` 只提示用户。所以"主密码不对"必须归到 no-master ——
   * 原先一律返回 error，一个记错的密码会让自动同步永久重试，每轮都白烧一次
   * 600k 轮 PBKDF2，而用户看到的只是反复弹出的同步提醒，没有任何线索指向
   * 主密码。
   *
   * 密码错时还要**清掉**记住的值，否则下一次手动 pull 仍会直接拿它去解密，
   * 不再提示输入。
   */
  async tryAutoSync(): Promise<'ok' | 'no-master' | 'error'> {
    const mp = await this.masterPasswordStore.get();
    if (!mp) return 'no-master';
    try {
      await this.pull(mp, true);
      await this.push(mp);
      await this.hashStore.update(SyncManager.LAST_SYNC_AT_KEY, Date.now());
      return 'ok';
    } catch (err) {
      if (err instanceof MasterPasswordError) {
        await this.masterPasswordStore.clear();
        return 'no-master';
      }
      return 'error';
    }
  }

  async rememberMasterPassword(masterPassword: string): Promise<void> {
    await this.masterPasswordStore.store(masterPassword);
  }

  async forgetMasterPassword(): Promise<void> {
    await this.masterPasswordStore.clear();
  }

  async getRememberedMasterPassword(): Promise<string | undefined> {
    return this.masterPasswordStore.get();
  }

  private async decryptSections(sections: Array<{ section: string; encryptedData: string; version: number }>, masterPassword: string): Promise<SyncPayload> {
    const payload: any = { version: 1, groups: [], connections: [], queries: [], queryFolders: [], history: [] };
    for (const sec of sections) {
      // 异步派生：同 push，避免解密多个 section 时冻结扩展主进程
      const obj = await Encryption.decryptAsync(sec.encryptedData, masterPassword);
      assignSection(payload, sec.section, obj);
      this.sectionVersions[sec.section as SectionType] = sec.version;
    }
    return parseSyncPayload(payload);
  }

  private async applyRemote(remote: SyncPayload, strategy: 'remote' | 'merge' = 'merge'): Promise<void> {
    const remoteTree = { groups: remote.groups, connections: remote.connections };
    const remoteQueries = { queries: remote.queries, folders: remote.queryFolders };
    if (strategy === 'remote') {
      await this.store.replaceAll(remoteTree);
      await this.store.replaceQueriesForSyncAll(remoteQueries);
    } else {
      await this.store.replaceAllMerge(remoteTree);
      await this.store.replaceQueriesForSync(remoteQueries);
    }
    // 历史为日志型数据，不做软删除，冲突无「远端覆盖/本地保留」之分，三策略恒为合并
    await this.history.replaceAllMerge(remote.history);
  }

  private async buildLocalPayload(): Promise<SyncPayload> {
    const tree = await this.store.getSyncData();
    const { queries, folders } = this.store.getQueriesForSync();
    const history = this.history.getSyncData();
    return {
      version: 1,
      groups: tree.groups,
      connections: tree.connections,
      queries,
      queryFolders: folders,
      history,
    };
  }

  /** 计算某节明文条数（服务端计量用；软删除墓碑不计） */
  private itemCountOf(section: SectionType, payload: SyncPayload): number {
    switch (section) {
      case 'groups': return payload.groups.filter((g) => !g.deleted).length;
      case 'connections': return payload.connections.filter((c) => !c.deleted).length;
      case 'queries': return payload.queries.filter((q: any) => !q.deleted).length;
      case 'folders': return payload.queryFolders.filter((f: any) => !f.deleted).length;
      case 'history': return payload.history.length;
    }
  }

  private async computeLocalHash(): Promise<string> {
    const payload = await this.buildLocalPayload();
    return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  private async updateLastSyncHash(): Promise<void> {
    const hash = await this.computeLocalHash();
    await this.hashStore.update(SyncManager.LAST_HASH_KEY, hash);
    await this.hashStore.update(SyncManager.LAST_SYNC_AT_KEY, Date.now());
  }
}
