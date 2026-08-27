import type { ISyncRepo, IUserRepo, IDeviceRepo, IConnectionMetaRepo, ConnectionMetaInput } from '../repository/interfaces.js';
import type { PlanPolicy } from '../policy/planPolicy.js';
import type { SectionType } from '../domain/enums.js';
import type { SyncSection, SyncVersionSummary } from '../domain/entities.js';
import { EntityNotFoundError, ConflictError, DeviceLimitError, VersionNotFoundError, ValidationError } from '../domain/errors.js';

export interface PushResult {
  version: number;
}

export interface SectionData {
  section: SectionType;
  encryptedData: string;
  version: number;
  updateTime: Date;
}

export interface PullResult {
  sections: SectionData[];
}

export interface PushInput {
  deviceId?: string;
  itemCount?: number;
  /** 仅 connections section：明文连接元数据清单（计量/分析；内容仍加密） */
  meta?: ConnectionMetaInput[];
}

/**
 * 同步服务：分节 push/pull + 配额校验 + 历史回滚。
 *
 * 端到端加密：server 仅见密文。但连接数 etc. 需服务端计量，
 * 故 push connections 时客户端附带明文元数据（connection_meta），
 * 据此校验 perUserMaxPrivateConnections 并落库；内容仍存 sync_sections 密文。
 */
export class SyncService {
  constructor(
    private readonly syncRepo: ISyncRepo,
    private readonly userRepo: IUserRepo,
    private readonly planPolicy: PlanPolicy,
    private readonly connectionMetaRepo: IConnectionMetaRepo,
    private readonly deviceRepo: IDeviceRepo,
  ) {}

  /**
   * 推送单节：连接数/字节配额前置校验 + 乐观锁 + 记历史 + 清理超限 + 事件留痕。
   *
   * 配额必须在写库**之前**校验：否则超额密文已经落库，403 只是事后通知。
   * 投影总量 = 当前总量 − 该节旧字节数 + 新字节数。
   */
  async push(userId: number, section: SectionType, encryptedData: string, baseVersion: number, input: PushInput = {}): Promise<PushResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    await this.requireDeviceBound(userId, input.deviceId);

    const newSectionBytes = Buffer.byteLength(encryptedData, 'utf8');

    // 连接数配额。
    //
    // 三条曾经的绕过路径，都必须堵住：
    //  1. 原判据是 `if (section === 'connections' && input.meta)` —— 不发 meta
    //     就完全跳过校验，而 meta 是可选字段，密文服务端又不解析，无从察觉。
    //     所以现在 connections 节**强制要求** meta。
    //  2. 原来校验的是入参条数，与库内存量无关。replaceAll 是全量替换语义，
    //     所以写入后的活跃数就等于入参里的非墓碑条数 —— 以此为投影总量。
    //  3. replaceAll 此前只 upsert 不删除，导致库内活跃行单调累加；已在
    //     ConnectionMetaRepo 修正为真正的全量替换。
    if (section === 'connections') {
      if (!input.meta) {
        throw new ValidationError('connections section requires meta for quota accounting');
      }
      // 客户端可能附带 deleted:true 的墓碑行——过滤后只计活跃连接
      const activeMeta = input.meta.filter((m) => !m.deleted);
      const projectedActive = activeMeta.length;
      await this.planPolicy.checkTotal(userId, 'connections', projectedActive);
    }

    await this.checkQuota(userId, section, newSectionBytes);

    // 当前版本与历史快照必须一起落盘（repo 内单事务）。分两次写会留下
    // 「当前行已是 version N，但历史里没有 N 的快照」的状态：用户回滚到自己
    // 刚推的那一版会得到 VERSION_NOT_FOUND。
    const newVersion = await this.syncRepo.pushSection(userId, section, encryptedData, baseVersion, newSectionBytes);
    if (newVersion === null) {
      const cur = await this.syncRepo.getSection(userId, section);
      throw new ConflictError(cur ? cur.version : 0, baseVersion);
    }

    // connection_meta 与密文不共享事务：跨仓储的原子性要引入 UnitOfWork，
    // 而这里失败的后果有限 —— meta 只是明文计量副本，配额校验取的是入参投影
    // （见上），不依赖库内 meta，所以 meta 落后一次不会放宽任何限制，
    // 下一次 push 会整体覆盖。
    if (section === 'connections' && input.meta) {
      // 过滤 deleted:true 的墓碑行——不 upsert，让 replaceAll 的 NOT IN 逻辑自动墓碑
      const activeMeta = input.meta.filter((m) => !m.deleted) as ConnectionMetaInput[];
      await this.connectionMetaRepo.replaceAll(userId, activeMeta);
    }

    const retention = await this.planPolicy.syncVersionRetention(userId);
    if (retention > 0) await this.syncRepo.pruneVersions(userId, section, retention);


    return { version: newVersion };
  }

  /**
   * 校验写入后的投影总字节数是否超配额。
   * 替换语义：该节旧字节数先减去，再加上新字节数。
   */
  private async checkQuota(
    userId: number,
    section: SectionType,
    incomingBytes: number,
  ): Promise<void> {
    const currentTotal = await this.syncRepo.sumBytes(userId);
    const existing = await this.syncRepo.getSection(userId, section);
    const existingBytes = existing ? Buffer.byteLength(existing.encryptedData, 'utf8') : 0;
    const projected = Math.max(0, currentTotal - existingBytes + incomingBytes);
    await this.planPolicy.checkTotal(userId, 'sync_bytes', projected);
  }

  /** 设备绑定检查（sync 硬卡）：已绑定放行；未绑定且配额未满则补绑；满则 403 */
  private async requireDeviceBound(userId: number, deviceId?: string): Promise<void> {
    if (!deviceId) return; // 旧客户端无设备信息，跳过（无法判同）
    const limit = await this.planPolicy.limit(userId, 'devices');
    if (limit <= 0) return; // 0 = 无限
    if (await this.deviceRepo.isBound(userId, deviceId)) return;
    const bound = await this.deviceRepo.countBound(userId);
    if (bound >= limit) throw new DeviceLimitError(limit, bound);
    await this.deviceRepo.bind(userId, deviceId);
  }

  /** 拉取：指定 section 单节，或全部 section */
  async pull(userId: number, section?: SectionType, deviceId?: string): Promise<PullResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    await this.requireDeviceBound(userId, deviceId);

    let sections: SyncSection[];
    if (section) {
      const s = await this.syncRepo.getSection(userId, section);
      sections = s ? [s] : [];
    } else {
      sections = await this.syncRepo.listSections(userId);
    }
    return { sections: sections.map(toSectionData) };
  }

  /** 列历史版本（按套餐保留数限制） */
  async listVersions(userId: number, section: SectionType): Promise<SyncVersionSummary[]> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    const retention = await this.planPolicy.syncVersionRetention(userId);
    return this.syncRepo.listVersions(userId, section, retention > 0 ? retention : 100);
  }

  /**
   * 回滚到指定版本（取旧密文写回当前，新 version=current+1）。
   * 同 push：回滚也是一次写入，需前置配额校验，否则可绕过配额。
   */
  async rollback(userId: number, section: SectionType, toVersion: number, deviceId?: string): Promise<PushResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    await this.requireDeviceBound(userId, deviceId);

    const target = await this.syncRepo.getVersion(userId, section, toVersion);
    if (!target) throw new VersionNotFoundError(userId, section, toVersion);
    await this.checkQuota(userId, section, Buffer.byteLength(target.encryptedData, 'utf8'));

    const newVersion = await this.syncRepo.rollback(userId, section, toVersion);
    const retention = await this.planPolicy.syncVersionRetention(userId);
    if (retention > 0) await this.syncRepo.pruneVersions(userId, section, retention);
    return { version: newVersion };
  }
}

function toSectionData(s: SyncSection): SectionData {
  return {
    section: s.section,
    encryptedData: s.encryptedData,
    version: s.version,
    updateTime: s.updateTime,
  };
}