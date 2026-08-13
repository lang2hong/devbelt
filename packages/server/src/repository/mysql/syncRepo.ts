import type { ISyncRepo } from '../interfaces.js';
import type { SyncSection, SyncSectionVersion, SyncVersionSummary } from '../../domain/entities.js';
import type { SectionType } from '../../domain/enums.js';
import { VersionNotFoundError } from '../../domain/errors.js';
import type { MysqlDb } from './db.js';

/**
 * 同步数据访问实现（方案 A：分节存储 + 历史版本回滚）。
 *
 * 当前版本表 sync_sections：一用户一 section 一行（user_id+section 主键）。
 * 历史版本表 sync_section_versions：每次 push 记录快照，rollback 取旧版本写回。
 * 端到端加密：server 仅搬运密文，不解密不合并。
 */
export class MysqlSyncRepo implements ISyncRepo {
  constructor(private readonly db: () => MysqlDb) {}

  async getSection(userId: number, section: SectionType): Promise<SyncSection | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM sync_sections WHERE user_id = ? AND section = ?',
      [userId, section],
    );
    return rows[0] ? mapSection(rows[0]) : undefined;
  }

  async listSections(userId: number): Promise<SyncSection[]> {
    const [rows] = await this.db().query<any[]>('SELECT * FROM sync_sections WHERE user_id = ?', [userId]);
    return rows.map(mapSection);
  }

  async sumBytes(userId: number): Promise<number> {
    const [rows] = await this.db().query<any[]>(
      'SELECT COALESCE(SUM(LENGTH(encrypted_data)), 0) AS total FROM sync_sections WHERE user_id = ?',
      [userId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** 写当前版本（INSERT 或 UPDATE）；version 为新版本号 */
  async putSection(userId: number, section: SectionType, encryptedData: string, version: number): Promise<number> {
    await this.db().query(
      `INSERT INTO sync_sections (user_id, section, encrypted_data, version)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE encrypted_data = VALUES(encrypted_data), version = VALUES(version), update_time = CURRENT_TIMESTAMP`,
      [userId, section, encryptedData, version],
    );
    return version;
  }

  /** 记录历史版本快照（回滚用） */
  async recordVersion(userId: number, section: SectionType, version: number, encryptedData: string, dataBytes: number): Promise<void> {
    await this.db().query(
      'INSERT INTO sync_section_versions (user_id, section, version, encrypted_data, data_bytes) VALUES (?, ?, ?, ?, ?)',
      [userId, section, version, encryptedData, dataBytes],
    );
  }

  /** 列历史版本摘要（最新优先，limit 条） */
  async listVersions(userId: number, section: SectionType, limit: number): Promise<SyncVersionSummary[]> {
    const [rows] = await this.db().query<any[]>(
      'SELECT version, data_bytes, create_time FROM sync_section_versions WHERE user_id = ? AND section = ? ORDER BY version DESC LIMIT ?',
      [userId, section, limit],
    );
    return rows.map((r: any) => ({
      version: r.version,
      dataBytes: r.data_bytes,
      createTime: new Date(r.create_time),
    }));
  }

  /** 取指定历史版本完整密文（回滚用） */
  async getVersion(userId: number, section: SectionType, version: number): Promise<SyncSectionVersion | undefined> {
    const [rows] = await this.db().query<any[]>(
      'SELECT * FROM sync_section_versions WHERE user_id = ? AND section = ? AND version = ?',
      [userId, section, version],
    );
    return rows[0] ? mapVersion(rows[0]) : undefined;
  }

  /** 清理超保留数的旧版本：保留最新 retention 条，删其余 */
  async pruneVersions(userId: number, section: SectionType, retention: number): Promise<void> {
    if (retention <= 0) return;
    await this.db().query(
      `DELETE FROM sync_section_versions WHERE user_id = ? AND section = ? AND id NOT IN (
        SELECT id FROM (
          SELECT id FROM sync_section_versions WHERE user_id = ? AND section = ? ORDER BY version DESC LIMIT ?
        ) t
      )`,
      [userId, section, userId, section, retention],
    );
  }

  /** 回滚：取 toVersion 密文写回当前行，新 version = current+1，并记历史 */
  async rollback(userId: number, section: SectionType, toVersion: number): Promise<number> {
    const target = await this.getVersion(userId, section, toVersion);
    if (!target) throw new VersionNotFoundError(userId, section, toVersion);
    const cur = await this.getSection(userId, section);
    const currentVersion = cur ? cur.version : 0;
    const newVersion = currentVersion + 1;
    await this.putSection(userId, section, target.encryptedData, newVersion);
    await this.recordVersion(userId, section, newVersion, target.encryptedData, target.dataBytes);
    return newVersion;
  }
}

function mapSection(r: any): SyncSection {
  return {
    userId: r.user_id,
    section: r.section as SectionType,
    encryptedData: r.encrypted_data,
    version: r.version,
    updateTime: new Date(r.update_time),
  };
}

function mapVersion(r: any): SyncSectionVersion {
  return {
    id: r.id,
    userId: r.user_id,
    section: r.section as SectionType,
    version: r.version,
    encryptedData: r.encrypted_data,
    dataBytes: r.data_bytes,
    createTime: new Date(r.create_time),
  };
}
