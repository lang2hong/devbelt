import { describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/repository/mysql/db.js';
import { MysqlSyncRepo } from '../../src/repository/mysql/syncRepo.js';
import { ConflictError, VersionNotFoundError } from '../../src/domain/errors.js';

/**
 * 极小 SQL 桩：只认 MysqlSyncRepo 实际发出的那几条语句（按特征子串匹配），
 * 用内存结构复刻 sync_sections / sync_section_versions 的行为，并实现
 * beginTransaction/commit/rollback 的快照语义。
 *
 * 为什么不用「重写 repo 方法」的 spy：那样测的只是编排，SQL 本身写错
 * （比如把乐观锁的 WHERE 条件漏掉）照样绿。桩按真实 SQL 的特征子串分派，
 * 语句形态一变就对不上，能守住「rollback 必须走条件更新」这条不变量。
 */
class StubDb {
  readonly database = 'stub';
  /** key = `${userId}:${section}` */
  sections = new Map<string, { version: number; data: string }>();
  versions: Array<{ userId: number; section: string; version: number; data: string; dataBytes: number }> = [];

  /** 按顺序记录收到的语句种类，用于断言事务边界 */
  log: string[] = [];
  /** 在处理 UPDATE sync_sections 之前触发，用来模拟并发写入 */
  onBeforeUpdate?: () => void;
  /** 命中该子串的语句直接抛错，用来注入失败 */
  failOn?: string;

  commits = 0;
  rollbacks = 0;
  releases = 0;
  begins = 0;
  /** 事务内的快照（begin 时拍，rollback 时还原） */
  private snapshot?: { sections: StubDb['sections']; versions: StubDb['versions'] };

  async query(sql: string, params: any[] = []): Promise<any> {
    if (this.failOn && sql.includes(this.failOn)) {
      this.log.push('FAIL');
      throw new Error(`injected failure: ${this.failOn}`);
    }

    if (sql.includes('UPDATE sync_sections')) {
      this.log.push('UPDATE sync_sections');
      this.onBeforeUpdate?.();
      const [data, newVersion, userId, section, baseVersion] = params;
      const k = `${userId}:${section}`;
      const row = this.sections.get(k);
      if (!row || row.version !== baseVersion) return [{ affectedRows: 0 }, []];
      this.sections.set(k, { version: newVersion, data });
      return [{ affectedRows: 1 }, []];
    }

    if (sql.includes('SELECT version FROM sync_sections')) {
      this.log.push('SELECT version FROM sync_sections');
      const [userId, section] = params;
      const row = this.sections.get(`${userId}:${section}`);
      return [row ? [{ version: row.version }] : [], []];
    }

    if (sql.includes('INSERT INTO sync_sections')) {
      this.log.push('INSERT INTO sync_sections');
      const [userId, section, data, version] = params;
      const k = `${userId}:${section}`;
      // 唯一键 uq_ss_user_section：纯 INSERT 撞键报错，带 ON DUPLICATE 则覆盖。
      // 两种都要复刻，否则「退回无条件 upsert」的变异会因为桩报错而红，
      // 掩盖掉本该由版本号断言抓出来的真实问题。
      if (this.sections.has(k)) {
        if (!/ON DUPLICATE KEY UPDATE/i.test(sql)) {
          const err: any = new Error('duplicate');
          err.code = 'ER_DUP_ENTRY';
          throw err;
        }
        this.sections.set(k, { version, data });
        return [{ affectedRows: 2 }, []];
      }
      this.sections.set(k, { version, data });
      return [{ affectedRows: 1 }, []];
    }

    if (sql.includes('SELECT * FROM sync_sections')) {
      this.log.push('SELECT * FROM sync_sections');
      const [userId, section] = params;
      const row = this.sections.get(`${userId}:${section}`);
      if (!row) return [[], []];
      const now = new Date();
      return [[{
        user_id: userId, section, encrypted_data: row.data, version: row.version,
        create_time: now, update_time: now,
      }], []];
    }

    if (sql.includes('SELECT * FROM sync_section_versions')) {
      this.log.push('SELECT * FROM sync_section_versions');
      const [userId, section, version] = params;
      const v = this.versions.find((x) => x.userId === userId && x.section === section && x.version === version);
      if (!v) return [[], []];
      const now = new Date();
      return [[{
        id: 1, user_id: v.userId, section: v.section, version: v.version,
        encrypted_data: v.data, data_bytes: v.dataBytes, create_time: now, update_time: now,
      }], []];
    }

    if (sql.includes('INSERT INTO sync_section_versions')) {
      this.log.push('INSERT INTO sync_section_versions');
      const [userId, section, version, data, dataBytes] = params;
      const existing = this.versions.find(
        (x) => x.userId === userId && x.section === section && x.version === version,
      );
      // 唯一键 (user_id, section, version) + ON DUPLICATE KEY UPDATE：覆盖而非新增一行
      if (existing) {
        if (!/ON DUPLICATE KEY UPDATE/i.test(sql)) {
          const err: any = new Error('duplicate');
          err.code = 'ER_DUP_ENTRY';
          throw err;
        }
        existing.data = data;
        existing.dataBytes = dataBytes;
        return [{ affectedRows: 2 }, []];
      }
      this.versions.push({ userId, section, version, data, dataBytes });
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`StubDb: 未预期的语句 ${sql.slice(0, 60)}`);
  }

  async getConnection() {
    const self = this;
    return {
      query: (sql: string, params?: any[]) => self.query(sql, params),
      async beginTransaction() {
        self.begins += 1;
        self.log.push('BEGIN');
        self.snapshot = {
          sections: new Map([...self.sections].map(([k, v]) => [k, { ...v }])),
          versions: self.versions.map((v) => ({ ...v })),
        };
      },
      async commit() {
        self.commits += 1;
        self.log.push('COMMIT');
        self.snapshot = undefined;
      },
      async rollback() {
        self.rollbacks += 1;
        self.log.push('ROLLBACK');
        if (self.snapshot) {
          self.sections = self.snapshot.sections;
          self.versions = self.snapshot.versions;
          self.snapshot = undefined;
        }
      },
      release() {
        self.releases += 1;
        self.log.push('RELEASE');
      },
    };
  }
}

function repoOf(db: StubDb) {
  return new MysqlSyncRepo(() => db as any);
}

describe('withTransaction', () => {
  it('成功路径：BEGIN → 回调 → COMMIT → RELEASE 顺序正确', async () => {
    const db = new StubDb();
    const out = await withTransaction(db as any, async (tx) => {
      await tx.query('INSERT INTO sync_sections (a) VALUES (?)', [1, 'groups', 'D', 1]);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(db.log).toEqual(['BEGIN', 'INSERT INTO sync_sections', 'COMMIT', 'RELEASE']);
  });

  it('回调抛错：ROLLBACK 且 RELEASE，原始错误原样抛出', async () => {
    const db = new StubDb();
    const err = await withTransaction(db as any, async () => {
      throw new Error('boom');
    }).catch((e: unknown) => e as Error);
    expect(err.message).toBe('boom');
    expect(db.log).toEqual(['BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  it('ROLLBACK 自身失败时不掩盖原始错误，且仍然 RELEASE', async () => {
    const db = new StubDb();
    const conn = await db.getConnection();
    conn.rollback = async () => { throw new Error('rollback failed'); };
    const fake = { database: 'x', query: db.query.bind(db), getConnection: async () => conn };
    const err = await withTransaction(fake as any, async () => {
      throw new Error('original');
    }).catch((e: unknown) => e as Error);
    expect(err.message).toBe('original');
    expect(db.releases).toBe(1);
  });

  it('COMMIT 失败也要 RELEASE 连接（否则池会被慢慢耗光）', async () => {
    const db = new StubDb();
    const conn = await db.getConnection();
    conn.commit = async () => { throw new Error('commit failed'); };
    const fake = { database: 'x', query: db.query.bind(db), getConnection: async () => conn };
    const err = await withTransaction(fake as any, async () => 1).catch((e: unknown) => e);
    expect((err as Error).message).toBe('commit failed');
    expect(db.releases).toBe(1);
  });
});

describe('MysqlSyncRepo.pushSection（乐观锁 + 历史快照同事务）', () => {
  it('首次写入：section 与 history 在同一个事务内落盘', async () => {
    const db = new StubDb();
    const v = await repoOf(db).pushSection(7, 'groups' as any, 'DATA-A', 0, 6);
    expect(v).toBe(1);
    expect(db.sections.get('7:groups')).toEqual({ version: 1, data: 'DATA-A' });
    expect(db.versions).toEqual([{ userId: 7, section: 'groups', version: 1, data: 'DATA-A', dataBytes: 6 }]);
    // 一个事务包住全部写入
    expect(db.begins).toBe(1);
    expect(db.commits).toBe(1);
    expect(db.rollbacks).toBe(0);
    expect(db.releases).toBe(1);
    expect(db.log.indexOf('BEGIN')).toBeLessThan(db.log.indexOf('INSERT INTO sync_section_versions'));
    expect(db.log.indexOf('INSERT INTO sync_section_versions')).toBeLessThan(db.log.indexOf('COMMIT'));
  });

  it('版本冲突：返回 null，section 与 history 都不动', async () => {
    const db = new StubDb();
    db.sections.set('7:groups', { version: 5, data: 'CURRENT' });
    const v = await repoOf(db).pushSection(7, 'groups' as any, 'STALE', 3, 5);
    expect(v).toBeNull();
    expect(db.sections.get('7:groups')).toEqual({ version: 5, data: 'CURRENT' });
    expect(db.versions).toHaveLength(0);
    expect(db.releases).toBe(1);
  });

  it('dataBytes = 0：只写当前版本，不留历史快照', async () => {
    const db = new StubDb();
    const v = await repoOf(db).pushSection(7, 'groups' as any, '', 0, 0);
    expect(v).toBe(1);
    expect(db.sections.get('7:groups')).toEqual({ version: 1, data: '' });
    expect(db.versions).toHaveLength(0);
  });

  it('历史快照写入失败时，当前版本一并回滚（不留下无快照的新版本）', async () => {
    const db = new StubDb();
    db.sections.set('7:groups', { version: 1, data: 'OLD' });
    db.failOn = 'INSERT INTO sync_section_versions';
    const err = await repoOf(db).pushSection(7, 'groups' as any, 'NEW', 1, 3).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // 关键断言：section 行必须回到写入前的状态
    expect(db.sections.get('7:groups')).toEqual({ version: 1, data: 'OLD' });
    expect(db.rollbacks).toBe(1);
    expect(db.releases).toBe(1);
  });

  it('同一 (user, section, version) 重复记快照只保留一行（唯一键 + upsert）', async () => {
    const db = new StubDb();
    const repo = repoOf(db);
    await repo.pushSection(7, 'groups' as any, 'A', 0, 1);
    // 手工把当前版本退回 0，制造「同一版本号被记两次」的场景
    db.sections.set('7:groups', { version: 0, data: 'A' });
    await repo.pushSection(7, 'groups' as any, 'B', 0, 1);
    expect(db.versions).toHaveLength(1);
    expect(db.versions[0]).toMatchObject({ version: 1, data: 'B' });
  });
});

describe('MysqlSyncRepo.rollback（必须走乐观锁，且与快照同事务）', () => {
  async function seed(db: StubDb) {
    const repo = repoOf(db);
    await repo.pushSection(7, 'groups' as any, 'V1', 0, 2);
    await repo.pushSection(7, 'groups' as any, 'V2', 1, 2);
    return repo;
  }

  it('正常回滚：新版本 = current + 1，写回旧密文并记快照', async () => {
    const db = new StubDb();
    const repo = await seed(db);
    const v = await repo.rollback(7, 'groups' as any, 1);
    expect(v).toBe(3);
    expect(db.sections.get('7:groups')).toEqual({ version: 3, data: 'V1' });
    expect(db.versions.map((x) => x.version).sort()).toEqual([1, 2, 3]);
    expect(db.versions.find((x) => x.version === 3)!.data).toBe('V1');
  });

  it('目标版本不存在 → VersionNotFoundError', async () => {
    const db = new StubDb();
    const repo = await seed(db);
    await expect(repo.rollback(7, 'groups' as any, 9)).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it('并发：读到版本后被别人抢先推进，绝不能覆盖对方的写入', async () => {
    const db = new StubDb();
    const repo = await seed(db);
    // 第一次 UPDATE 之前，另一端把 version 从 2 推到 3
    let fired = false;
    db.onBeforeUpdate = () => {
      if (fired) return;
      fired = true;
      db.sections.set('7:groups', { version: 3, data: 'OTHER-DEVICE' });
    };
    const v = await repo.rollback(7, 'groups' as any, 1);
    // 重试后基于真实当前版本 3 写成 4；对方那次写入没有被无声吞掉
    expect(v).toBe(4);
    expect(db.sections.get('7:groups')).toEqual({ version: 4, data: 'V1' });
    // 无条件 upsert 的旧实现会直接写成 version=3 覆盖 OTHER-DEVICE
    expect(db.versions.some((x) => x.version === 4)).toBe(true);
  });

  it('持续冲突超过重试上限 → ConflictError，而不是无声覆盖', async () => {
    const db = new StubDb();
    const repo = await seed(db);
    let n = 100;
    db.onBeforeUpdate = () => {
      db.sections.set('7:groups', { version: ++n, data: 'MOVING' });
    };
    const err = await repo.rollback(7, 'groups' as any, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    // 数据停在别人最后一次写入上，没有被回滚内容覆盖
    expect(db.sections.get('7:groups')!.data).toBe('MOVING');
  });

  it('回滚的 section 写入与快照写入同事务：快照失败则当前版本不前进', async () => {
    const db = new StubDb();
    const repo = await seed(db);
    db.failOn = 'INSERT INTO sync_section_versions';
    await expect(repo.rollback(7, 'groups' as any, 1)).rejects.toThrow();
    expect(db.sections.get('7:groups')).toEqual({ version: 2, data: 'V2' });
  });
});
