import type { ISyncRepo, IUserRepo } from '../repository/interfaces.js';
import type { PlanPolicy } from '../policy/planPolicy.js';
import type { SectionType } from '../domain/enums.js';
import type { SyncSection, SyncVersionSummary } from '../domain/entities.js';
import { EntityNotFoundError, ConflictError } from '../domain/errors.js';

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

/**
 * 同步服务：分节 push/pull + 配额校验 + 历史回滚。
 *
 * 端到端加密：server 仅见密文，合并/解密在客户端。server 职责：
 * - 分节存储当前版本 + 历史快照
 * - 乐观锁（baseVersion 校验）+ sync_quota_bytes 配额
 * - 回滚（取旧版本密文写回当前行，新 version=current+1）
 */
export class SyncService {
  constructor(
    private readonly syncRepo: ISyncRepo,
    private readonly userRepo: IUserRepo,
    private readonly planPolicy: PlanPolicy,
  ) {}

  /** 推送单节：乐观锁校验 + 配额校验 + 记历史 + 清理超限 */
  async push(userId: number, section: SectionType, encryptedData: string, baseVersion: number): Promise<PushResult> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new EntityNotFoundError('user', userId);

    const newVersion = await this.syncRepo.putSectionIfVersion(userId, section, encryptedData, baseVersion);
    if (newVersion === null) {
      const cur = await this.syncRepo.getSection(userId, section);
      throw new ConflictError(cur ? cur.version : 0, baseVersion);
    }

    const newSectionBytes = Buffer.byteLength(encryptedData, 'utf8');
    const currentTotal = await this.syncRepo.sumBytes(userId);
    await this.planPolicy.check(user.planCode, 'sync_bytes', currentTotal);
    if (newSectionBytes > 0) {
      await this.syncRepo.recordVersion(userId, section, newVersion, encryptedData, newSectionBytes);
    }

    const retention = await this.planPolicy.syncVersionRetention(user.planCode);
    if (retention > 0) await this.syncRepo.pruneVersions(userId, section, retention);

    return { version: newVersion };
  }

  /** 拉取：指定 section 单节，或全部 section */
  async pull(userId: number, section?: SectionType): Promise<PullResult> {
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
    const retention = await this.planPolicy.syncVersionRetention(user.planCode);
    return this.syncRepo.listVersions(userId, section, retention > 0 ? retention : 100);
  }

  /** 回滚到指定版本（取旧密文写回当前，新 version=current+1） */
  async rollback(userId: number, section: SectionType, toVersion: number): Promise<PushResult> {
    const newVersion = await this.syncRepo.rollback(userId, section, toVersion);
    const user = await this.userRepo.findById(userId);
    if (user) {
      const retention = await this.planPolicy.syncVersionRetention(user.planCode);
      if (retention > 0) await this.syncRepo.pruneVersions(userId, section, retention);
    }
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
