import { describe, expect, it } from 'vitest';
import { MysqlConnectionMetaRepo } from '../../src/repository/mysql/connectionMetaRepo.js';
import type { ConnectionMetaInput } from '../../src/repository/interfaces.js';

/**
 * connection_meta 的「全量替换」由两半组成：上报行 upsert + 未上报行置墓碑（delete_time）。
 * 两半之间断开会留下**半套数据**。分片写入（>200 条）更是把窗口拉长到多条语句。
 * 所以必须包在一个事务里。
 */
class StubDb {
  readonly database = 'stub';
  /** conn_id → 0(有效) / 1(已软删) */
  rows = new Map<string, number>();
  log: string[] = [];
  failOn?: string;

  begins = 0;
  commits = 0;
  rollbacks = 0;
  releases = 0;
  private snapshot?: Map<string, number>;

  async query(sql: string, params: any[] = []): Promise<any> {
    if (this.failOn && sql.includes(this.failOn)) {
      this.log.push('FAIL');
      throw new Error(`injected failure: ${this.failOn}`);
    }

    if (sql.includes('INSERT INTO connection_meta')) {
      this.log.push('UPSERT');
      // params 每 8 个一组：userId, connId, type, name, groupName, enabled, clientCreatedAt, clientUpdatedAt
      for (let i = 0; i < params.length; i += 8) {
        this.rows.set(params[i + 1], 0);
      }
      return [{ affectedRows: params.length / 8 }, []];
    }

    if (sql.includes('UPDATE connection_meta')) {
      const tombstone = sql.includes('NOT IN');
      this.log.push(tombstone ? 'TOMBSTONE' : 'CLEAR_ALL');
      const keep = tombstone ? new Set(params.slice(1)) : new Set<any>();
      for (const [uuid, deleted] of this.rows) {
        if (deleted === 0 && !keep.has(uuid)) this.rows.set(uuid, 1);
      }
      return [{ affectedRows: 0 }, []];
    }

    if (sql.includes('SELECT COUNT(*) AS cnt FROM connection_meta')) {
      this.log.push('COUNT');
      let c = 0;
      for (const deleted of this.rows.values()) if (deleted === 0) c += 1;
      return [[{ cnt: c }], []];
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
        self.snapshot = new Map(self.rows);
      },
      async commit() { self.commits += 1; self.log.push('COMMIT'); self.snapshot = undefined; },
      async rollback() {
        self.rollbacks += 1;
        self.log.push('ROLLBACK');
        if (self.snapshot) { self.rows = self.snapshot; self.snapshot = undefined; }
      },
      release() { self.releases += 1; self.log.push('RELEASE'); },
    };
  }
}

function meta(id: string): ConnectionMetaInput {
  return { connId: id, type: 'mysql', name: id, enabled: true };
}

describe('MysqlConnectionMetaRepo.replaceAll 事务性', () => {
  it('upsert + 墓碑 + 计数全部在一个事务内', async () => {
    const db = new StubDb();
    const repo = new MysqlConnectionMetaRepo(() => db as any);
    const n = await repo.replaceAll(1, [meta('a'), meta('b')]);
    expect(n).toBe(2);
    expect(db.log).toEqual(['BEGIN', 'UPSERT', 'TOMBSTONE', 'COUNT', 'COMMIT', 'RELEASE']);
    expect(db.begins).toBe(1);
    expect(db.commits).toBe(1);
  });

  it('墓碑语句失败 → 之前的 upsert 一并回滚，不留半套数据', async () => {
    const db = new StubDb();
    db.rows.set('old', 0);
    const repo = new MysqlConnectionMetaRepo(() => db as any);
    db.failOn = 'NOT IN';
    await expect(repo.replaceAll(1, [meta('a')])).rejects.toThrow();
    expect(db.rows.has('a')).toBe(false);
    expect(db.rows.get('old')).toBe(0);
    expect(db.rollbacks).toBe(1);
    expect(db.releases).toBe(1);
  });

  it('分片写入（>200 条）仍只有一个事务', async () => {
    const db = new StubDb();
    const repo = new MysqlConnectionMetaRepo(() => db as any);
    const metas = Array.from({ length: 450 }, (_, i) => meta(`c${i}`));
    const n = await repo.replaceAll(1, metas);
    expect(n).toBe(450);
    expect(db.begins).toBe(1);
    expect(db.commits).toBe(1);
    expect(db.log.filter((x) => x === 'UPSERT')).toHaveLength(3); // 200 + 200 + 50
    expect(db.log[0]).toBe('BEGIN');
    expect(db.log.at(-1)).toBe('RELEASE');
  });

  it('空入参：只有一条清空语句，不必开事务', async () => {
    const db = new StubDb();
    db.rows.set('old', 0);
    const repo = new MysqlConnectionMetaRepo(() => db as any);
    expect(await repo.replaceAll(1, [])).toBe(0);
    expect(db.log).toEqual(['CLEAR_ALL']);
    expect(db.begins).toBe(0);
    expect(db.rows.get('old')).toBe(1);
  });
});