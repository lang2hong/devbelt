import type { ISyncRepo } from '../interfaces.js';
import type { SyncSection, SyncSectionVersion, SyncVersionSummary } from '../../domain/entities.js';
import type { SectionType } from '../../domain/enums.js';
import { ConflictError, VersionNotFoundError } from '../../domain/errors.js';
import { withTransaction, type MysqlDb } from './db.js';

/** 能执行 SQL 的东西：连接池或事务连接。让同一段 SQL 既能独立跑也能进事务。 */
type Exec = { query<T = any>(sql: string, params?: any[]): Promise<T> };

/**
 * rollback 的乐观锁重试上限。
 *
 * 回滚是「读当前版本 → 基于它写下一版」，中间被别的设备抢先推进就得重来。
 * 重试而不是直接报错：抢先者写的是**别的内容**，回滚意图本身没被否决，
 * 重新基于新版本写一遍即可。3 次仍冲突说明有客户端在高频推送，
 * 此时报 409 让用户稍后再试，比无限重试占着连接更好。
 */
const ROLLBACK_MAX_ATTEMPTS = 3;

/**
 * 同步数据访问实现（方案 A：分节存储 + 历史版本回滚）。
 *
 * 当前版本表 sync_sections：一用户一 section 一行（user_id+section 唯一键）。
 * 历史版本表 sync_section_versions：每次 push 记录快照，rollback 取旧版本写回，
 * (user_id, section, version) 唯一。
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

  /** 写当前版本（INSERT 或 UPDATE）；version 为新版本号。无版本校验，仅供管理/播种路径使用 */
  async putSection(userId: number, section: SectionType, encryptedData: string, version: number): Promise<number> {
    await this.db().query(
      `INSERT INTO sync_sections (user_id, section, encrypted_data, version)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE encrypted_data = VALUES(encrypted_data), version = VALUES(version), update_time = CURRENT_TIMESTAMP`,
      [userId, section, encryptedData, version],
    );
    return version;
  }

  /**
   * push 的原子写入：乐观锁更新当前版本 + 记录历史快照，**同一个事务**。
   *
   * 拆成两次独立查询会留下一个真实的坏状态：当前行已经到了 version N，
   * 而 sync_section_versions 里没有 N 的快照。此后用户想回滚到 N 会得到
   * VERSION_NOT_FOUND —— 数据还在当前行里，却在历史列表中不可见，
   * 用户看到的是「我刚推的那一版凭空消失了」。
   *
   * dataBytes = 0（空密文，通常是客户端清空了该节）不记快照：
   * 保留一堆空快照没有回滚价值，只占配额。
   *
   * 返回新版本号；null 表示版本冲突（此时事务内未产生任何写入）。
   */
  async pushSection(
    userId: number,
    section: SectionType,
    encryptedData: string,
    baseVersion: number,
    dataBytes: number,
  ): Promise<number | null> {
    return withTransaction(this.db(), async (tx) => {
      const newVersion = await this.putSectionIfVersionOn(tx, userId, section, encryptedData, baseVersion);
      if (newVersion === null) return null;
      if (dataBytes > 0) {
        await this.recordVersionOn(tx, userId, section, newVersion, encryptedData, dataBytes);
      }
      return newVersion;
    });
  }

  /**
   * 乐观锁写入：仅当当前版本 === baseVersion 时才写，否则返回 null 表示冲突。
   * 不带历史快照，也不开事务 —— 单语句本身原子。push 路径请走 `pushSection`。
   */
  async putSectionIfVersion(userId: number, section: SectionType, encryptedData: string, baseVersion: number): Promise<number | null> {
    return this.putSectionIfVersionOn(this.db(), userId, section, encryptedData, baseVersion);
  }

  /**
   * 乐观锁写入的实现本体（可跑在池上或事务连接上）。
   *
   * ## 为什么不能用 INSERT ... ON DUPLICATE KEY UPDATE 加回读判断
   *
   * 原实现是「一条 upsert 里用 `IF(version = base, …)` 条件更新，再回读 version
   * 与 base+1 比较」。这个判据在**落后正好一个版本**时会误判成功：
   *
   *   行现有 version = V，客户端传 base = V-1
   *   → IF(version = base) 不匹配，数据和 version 都没动，仍是 V
   *   → 回读得到 V，而 base+1 = V，两者相等 → 判定为“写入成功”
   *
   * 而 base = V-1 恰恰是最常见的冲突场景：两台设备先后推送同一 section，
   * 后一台手里的 base 就落后一版。于是 `syncService.push` 不抛 ConflictError，
   * 客户端记下新版本号并标记“已同步”，**用户的本地修改被静默丢弃**。
   * 历史版本表还会记进一条根本没写进当前表的快照，导致历史与现状不一致。
   *
   * 另一个洞：行不存在时任何 base 都放行（base=5 也能 INSERT 出 version=6），
   * 等于首次写入完全不校验。
   *
   * ## 现在的做法
   *
   * 先 UPDATE 判 affectedRows，再按“行是否存在”决定是插入还是报冲突：
   *
   *   UPDATE 命中 1 行            → 成功
   *   UPDATE 命中 0 行 + 行不存在 → 首次写入，仅当 base = 0 才允许 INSERT
   *   UPDATE 命中 0 行 + 行存在   → 版本不符，冲突
   *
   * 注意 affectedRows 而非 changedRows：mysql2 默认不带 CLIENT_FOUND_ROWS，
   * affectedRows 是“实际改动的行数”。相同内容重复推送时 MySQL 会返回 0 ——
   * 但这里 version 每次都递增，行内容必然变化，所以不会误判。
   *
   * 并发安全靠唯一键 uq_ss_user_section (user_id, section)：两个请求同时走到
   * INSERT 分支时只有一个成功，另一个拿 ER_DUP_ENTRY，按冲突处理。
   * 在事务里则是后者先阻塞在唯一索引上，等前者提交后再拿 ER_DUP_ENTRY ——
   * 结果相同，只是被串行化了。
   */
  private async putSectionIfVersionOn(
    exec: Exec,
    userId: number,
    section: SectionType,
    encryptedData: string,
    baseVersion: number,
  ): Promise<number | null> {
    const newVersion = baseVersion + 1;

    const [upd] = await exec.query<any>(
      `UPDATE sync_sections
          SET encrypted_data = ?, version = ?, update_time = CURRENT_TIMESTAMP
        WHERE user_id = ? AND section = ? AND version = ?`,
      [encryptedData, newVersion, userId, section, baseVersion],
    );
    if ((upd?.affectedRows ?? 0) > 0) return newVersion;

    // 没更新到：要么行不存在（首次写入），要么版本不符（冲突）
    const [rows] = await exec.query<any[]>(
      'SELECT version FROM sync_sections WHERE user_id = ? AND section = ?',
      [userId, section],
    );
    if (rows.length > 0) return null; // 行存在但版本不符 → 冲突

    // 首次写入必须从 0 开始。base > 0 说明客户端手里的版本号来自别处
    // （比如账号被重置过），不能凭空造出一个高版本行。
    if (baseVersion !== 0) return null;

    try {
      await exec.query(
        'INSERT INTO sync_sections (user_id, section, encrypted_data, version) VALUES (?, ?, ?, ?)',
        [userId, section, encryptedData, newVersion],
      );
      return newVersion;
    } catch (e: any) {
      // 并发下另一个请求先插入了同一 (user_id, section)：唯一键拦住，按冲突处理
      if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) return null;
      throw e;
    }
  }

  /** 记录历史版本快照（回滚用） */
  async recordVersion(userId: number, section: SectionType, version: number, encryptedData: string, dataBytes: number): Promise<void> {
    await this.recordVersionOn(this.db(), userId, section, version, encryptedData, dataBytes);
  }

  /**
   * 快照写入用 upsert 而不是纯 INSERT。
   *
   * (user_id, section, version) 上有唯一键 uq_sv_user_section。正常流程下版本号
   * 单调递增，不会撞键；但「撞了就 500」并不是这里想要的行为 —— 快照按定义
   * 就是「某个版本的内容」，同一版本写两次的正确结果是覆盖，而不是失败。
   * 这也让上层的重试天然幂等。
   */
  private async recordVersionOn(
    exec: Exec,
    userId: number,
    section: SectionType,
    version: number,
    encryptedData: string,
    dataBytes: number,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO sync_section_versions (user_id, section, version, encrypted_data, data_bytes)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE encrypted_data = VALUES(encrypted_data), data_bytes = VALUES(data_bytes)`,
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

  /**
   * 回滚：取 toVersion 密文写回当前行，新 version = current+1，并记历史快照。
   *
   * 旧实现是「读当前版本 → putSection 无条件 upsert 写 current+1」，两个问题：
   *
   * 1. **丢写**。两个并发回滚都读到 current = V，都无条件写 V+1，后者覆盖前者，
   *    但两者都返回「成功，新版本 V+1」。同理，回滚与另一台设备的 push 并发时，
   *    push 刚写进去的内容会被回滚无声盖掉 —— 而 push 已经告知客户端成功了。
   * 2. **历史表出现重复版本号**。两次都记 V+1 的快照，`getVersion` 取 rows[0]
   *    等于随机挑一条，回滚结果变得不可预测。
   *
   * 现在走乐观锁：以读到的 current 作为 baseVersion，写不进去就重新读、重试。
   * 写当前行与记快照在同一事务内（见 pushSection）。
   */
  async rollback(userId: number, section: SectionType, toVersion: number): Promise<number> {
    let lastSeen = 0;
    for (let attempt = 0; attempt < ROLLBACK_MAX_ATTEMPTS; attempt++) {
      const target = await this.getVersion(userId, section, toVersion);
      if (!target) throw new VersionNotFoundError(userId, section, toVersion);

      const cur = await this.getSection(userId, section);
      lastSeen = cur ? cur.version : 0;

      // 字节数按密文重算，不用历史行里的 data_bytes：那是写入当时算的，
      // 与当前这次写入的内容是否一致无法保证，配额与用量都以实际字节为准。
      const dataBytes = Buffer.byteLength(target.encryptedData, 'utf8');
      const newVersion = await this.pushSection(userId, section, target.encryptedData, lastSeen, dataBytes);
      if (newVersion !== null) return newVersion;
    }
    // base 取回滚目标版本：客户端看到的是「你要基于 v{toVersion} 回滚，但当前已经是 v{lastSeen}」
    throw new ConflictError(lastSeen, toVersion);
  }
}

function mapSection(r: any): SyncSection {
  return {
    userId: r.user_id,
    section: r.section as SectionType,
    encryptedData: r.encrypted_data,
    version: r.version,
    createTime: new Date(r.create_time),
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
    updateTime: new Date(r.update_time),
  };
}
