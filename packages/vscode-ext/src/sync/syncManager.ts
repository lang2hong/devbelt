import * as crypto from 'crypto';
import { ConnectionStore } from '../connection/connectionStore';
import { HistoryStore } from '../history/historyStore';
import { AuthService } from './authService';
import { Encryption } from './encryption';
import { parseSyncPayload, type SyncPayload } from './syncPayload';
import { computeMergePlan, totalLocalOnly, type MergePlan } from './mergePlan';
import { MasterPasswordStore } from './masterPasswordStore';

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
  ) {}

  async pull(masterPassword: string, force = false): Promise<void> {
    if (!force) {
      if (await this.isLocalDirty()) throw new SyncLocalDirtyError();
    }
    const result = await this.auth.client.fetchSections();
    const payload = await this.decryptSections(result.sections, masterPassword);
    await this.applyRemote(payload);
    await this.updateLastSyncHash();
  }

  async push(masterPassword: string): Promise<void> {
    const payload = await this.buildLocalPayload();
    for (const section of SECTION_TYPES) {
      const data = sectionDataOf(payload, section);
      const enc = Encryption.encrypt(data, masterPassword);
      const base = this.sectionVersions[section] ?? 0;
      const { version } = await this.auth.client.pushSection(section, enc, base);
      this.sectionVersions[section] = version;
    }
    await this.updateLastSyncHash();
  }

  /** 强制推送：先拉远端 versions 作 base，避免冲突，再推本地 */
  async forcePush(masterPassword: string): Promise<void> {
    const result = await this.auth.client.fetchSections();
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
    const result = await this.auth.client.fetchSections();
    const remote = await this.decryptSections(result.sections, masterPassword);
    this.pendingRemote = remote;
    const local = await this.buildLocalPayload();
    const plan = computeMergePlan(local, remote);
    const hasLocalUnpushed = (await this.isLocalDirty()) || totalLocalOnly(plan) > 0;
    return { ...plan, hasLocalUnpushed };
  }

  async applyPreviewedPull(): Promise<void> {
    if (!this.pendingRemote) throw new Error('no previewed remote data to apply');
    await this.applyRemote(this.pendingRemote);
    this.pendingRemote = undefined;
    await this.updateLastSyncHash();
  }

  /** 列某节历史版本 */
  async listVersions(section: string): Promise<Array<{ version: number; dataBytes: number; createTime: string }>> {
    return this.auth.client.listVersions(section);
  }

  /** 回滚某节到指定版本 */
  async rollback(section: string, toVersion: number, masterPassword: string): Promise<void> {
    await this.auth.client.rollback(section, toVersion);
    // 回滚后刷新本地该节
    const result = await this.auth.client.fetchSections(section);
    if (result.sections.length) {
      const payload = await this.decryptSections(result.sections, masterPassword);
      await this.applyRemote(payload);
    }
  }

  getVersion(): number {
    return 0; // 分节无全局 version，保留接口兼容
  }

  getLastSyncAt(): number {
    return this.hashStore.get<number>(SyncManager.LAST_SYNC_AT_KEY) ?? 0;
  }

  async tryAutoSync(): Promise<'ok' | 'no-master' | 'error'> {
    const mp = await this.masterPasswordStore.get();
    if (!mp) return 'no-master';
    try {
      await this.pull(mp, true);
      await this.push(mp);
      await this.hashStore.update(SyncManager.LAST_SYNC_AT_KEY, Date.now());
      return 'ok';
    } catch {
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
      const obj = Encryption.decrypt(sec.encryptedData, masterPassword);
      assignSection(payload, sec.section, obj);
      this.sectionVersions[sec.section as SectionType] = sec.version;
    }
    return parseSyncPayload(payload);
  }

  private async applyRemote(remote: SyncPayload): Promise<void> {
    await this.store.replaceAllMerge({ groups: remote.groups, connections: remote.connections });
    await this.store.replaceQueriesForSync({ queries: remote.queries, folders: remote.queryFolders });
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

  private async computeLocalHash(): Promise<string> {
    const payload = await this.buildLocalPayload();
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private async updateLastSyncHash(): Promise<void> {
    const hash = await this.computeLocalHash();
    await this.hashStore.update(SyncManager.LAST_HASH_KEY, hash);
    await this.hashStore.update(SyncManager.LAST_SYNC_AT_KEY, Date.now());
  }
}
