import type { ISyncRepo, IUserRepo, IConnectionMetaRepo, ISyncEventRepo, ConnectionMetaInput } from '../repository/interfaces.js';
import type { PlanPolicy } from '../policy/planPolicy.js';
import type { SectionType } from '../domain/enums.js';
import type { SyncSection, SyncVersionSummary } from '../domain/entities.js';
import { EntityNotFoundError, ConflictError, VersionNotFoundError } from '../domain/errors.js';

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
 * 据此校验 maxConnections 并落库；内容仍存 sync_sections 密文。
 * 每次 pull/push 写 sync_events 留痕。
 */
export class SyncService {
  constructor(
    private readonly syncRepo: ISyncRepo,
    private readonly userRepo: IUserRepo,
    private readonly planPolicy: PlanPolicy,
    private readonly connectionMetaRepo: IConnectionMetaRepo,
    private readonly syncEventRepo: ISyncEventRepo,
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

    const newSectionBytes = Buffer.byteLength(encryptedData, 'utf8');

    // 连接数配额：仅 connections section，按明文元数据计（先于写库）
    if (section === 'connections' && input.meta) {
      const activeCount = input.meta.filter((m) => !m.deleted).length;
      await this.planPolicy.check(user.planCode, 'connections', activeCount);
    }

    await this.checkQuota(userId, user.planCode, section, newSectionBytes);

    const newVersion = await this.syncRepo.putSectionIfVersion(userId, section, encryptedData, baseVersion);
    if (newVersion === null) {
      const cur = await this.syncRepo.getSection(userId, section);
      throw new ConflictError(cur ? cur.version : 0, baseVersion);
    }

    if (section === 'connections' && input.meta) {
      await this.connectionMetaRepo.replaceAll(userId, input.meta);
    }

    if (newSectionBytes > 0) {
      await this.syncRepo.recordVersion(userId, section, newVersion, encryptedData, newSectionBytes);
    }

    const retention = await this.planPolicy.syncVersionRetention(user.planCode);
    if (retention > 0) await this.syncRepo.pruneVersions(userId, section, retention);

    await this.syncEventRepo.record({
      userId, deviceId: input.deviceId, direction: 'push', section,
      bytes: newSectionBytes, itemCount: input.itemCount ?? 0,
    });

    return { version: newVersion };
  }

  /**
   * 校验写入后的投影总字节数是否超配额。
   * 替换语义：该节旧字节数先减去，再加上新字节数。
   */
  private async checkQuota(
    userId: number,
    planCode: Parameters<PlanPolicy['check']>[0],
    section: SectionType,
    incomingBytes: number,
  ): Promise<void> {
    const currentTotal = await this.syncRepo.sumBytes(userId);
    const existing = await this.syncRepo.getSection(userId, section);
    const existingBytes = existing ? Buffer.byteLength(existing.encryptedData, 'utf8') : 0;
    const projected = Math.max(0, currentTotal - existingBytes + incomingBytes);
    await this.planPolicy.check(planCode, 'sync_bytes', projected);
  }

  /** 拉取：指定 section 单节，或全部 section（每节写 pull 事件留痕） */
  async pull(userId: number, section?: SectionType, deviceId?: string): Promise<PullResult> {
    let sections: SyncSection[];
    if (section) {
      const s = await this.syncRepo.getSection(userId, section);
      sections = s ? [s] : [];
    } else {
      sections = await this.syncRepo.listSections(userId);
    }
    for (const s of sections) {
      await this.syncEventRepo.record({
        userId, deviceId, direction: 'pull', section: s.section,
        bytes: Buffer.byteLength(s.encryptedData, 'utf8'), itemCount: 0,
      });
    }
    return { sections: sections.map(toSectionData) };
  }

  /** 列历史版本（按套餐保留数限制） */
  async listVersions(userId: number, section: SectionType): Promise<SyncVersionSummary[]> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);
    const retention = await this.planPolicy.syncVersionRetention(user.planCode);
    return this.syncRepo.listVersions(userId, section, retention > 0 ? retention : 100);
  }

  /**
   * 回滚到指定版本（取旧密文写回当前，新 version=current+1）。
   * 同 push：回滚也是一次写入，需前置配额校验，否则可绕过配额。
   */
  async rollback(userId: number, section: SectionType, toVersion: number): Promise<PushResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);

    const target = await this.syncRepo.getVersion(userId, section, toVersion);
    if (!target) throw new VersionNotFoundError(userId, section, toVersion);
    await this.checkQuota(userId, user.planCode, section, Buffer.byteLength(target.encryptedData, 'utf8'));

    const newVersion = await this.syncRepo.rollback(userId, section, toVersion);
    const retention = await this.planPolicy.syncVersionRetention(user.planCode);
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