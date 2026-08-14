import { describe, expect, it } from 'vitest';
import { QueryHistoryRecorder } from '../../src/history/queryHistoryRecorder';

const conn: any = {
  id: 'c1',
  name: 'local',
  host: 'localhost',
  database: 'app',
  dbType: 'MYSQL',
};

function makeRecorder(): { observe: (sql: string, extra?: Partial<{ costTime: number; rowCount: number; affectedRows: number }>) => void; added: any[] } {
  const added: any[] = [];
  const history: any = { add: async (entry: any) => { added.push(entry); } };
  const recorder = new QueryHistoryRecorder(conn, history);
  const observer = recorder.observer();
  return {
    added,
    observe: (sql, extra = {}) => observer({ sql, costTime: 1, rowCount: 0, ...extra }),
  };
}

describe('QueryHistoryRecorder', () => {
  it('记录 DDL', () => {
    const { observe, added } = makeRecorder();
    observe('ALTER TABLE `users` ADD COLUMN `age` int');
    expect(added).toHaveLength(1);
    expect(added[0].sql).toBe('ALTER TABLE `users` ADD COLUMN `age` int');
    expect(added[0].connection).toBe('local');
    expect(added[0].connectionId).toBe('c1');
    expect(added[0].database).toBe('app');
  });

  it('记录 DML 并优先取 affectedRows', () => {
    const { observe, added } = makeRecorder();
    observe("UPDATE `users` SET `name` = 'x' WHERE `id` = 1", { costTime: 9, affectedRows: 3, rowCount: 0 });
    expect(added).toHaveLength(1);
    expect(added[0].costTime).toBe(9);
    expect(added[0].rowCount).toBe(3);
  });

  /**
   * 只读语句不进历史：元数据查询由树展开/补全自动触发，量大且对用户无意义，
   * 记录它们会把上限 100 条的历史冲干。
   */
  it('不记录读语句与事务控制', () => {
    const { observe, added } = makeRecorder();
    observe('SELECT * FROM users');
    observe('SHOW TABLES');
    observe('BEGIN');
    observe('COMMIT');
    observe('ROLLBACK');
    observe('SET AUTOCOMMIT = 0');
    observe('EXPLAIN SELECT 1');
    expect(added).toEqual([]);
  });

  /**
   * 关键安全断言：历史会持久化到 globalState 并参与云同步，
   * 明文密码一旦写进去就会离开本机。
   */
  it('不记录含密码的语句', () => {
    const { observe, added } = makeRecorder();
    observe("CREATE USER 'a'@'%' IDENTIFIED BY 'secret'");
    observe("ALTER USER 'a'@'%' IDENTIFIED BY 'secret'");
    observe('CREATE ROLE "a" WITH LOGIN PASSWORD \'secret\'');
    observe('ALTER ROLE "a" WITH PASSWORD \'secret\'');
    expect(added).toEqual([]);
  });

  it('不含密码的用户管理语句仍然记录', () => {
    const { observe, added } = makeRecorder();
    observe("DROP USER IF EXISTS 'a'@'%'");
    observe("GRANT SELECT ON `app`.* TO 'a'@'%'");
    expect(added.map((e) => e.sql)).toEqual([
      "DROP USER IF EXISTS 'a'@'%'",
      "GRANT SELECT ON `app`.* TO 'a'@'%'",
    ]);
  });

  /**
   * 会话会被 USE 切库（结果面板切库、导入前切库）。若一直用 conn.database，
   * 历史里的库名会与实际执行库不符，从历史恢复上下文时就跑到错误的库上。
   */
  it('跟随 USE 更新库名，且 USE 自身不入历史', () => {
    const { observe, added } = makeRecorder();
    observe('USE `other`');
    observe('DROP TABLE `t`');
    expect(added).toHaveLength(1);
    expect(added[0].database).toBe('other');
  });

  it('跟随 PG 的 SET search_path', () => {
    const { observe, added } = makeRecorder();
    observe('SET search_path TO reporting');
    observe('DROP TABLE "t"');
    expect(added).toHaveLength(1);
    expect(added[0].database).toBe('reporting');
  });

  /**
   * 历史写入是 best-effort：失败绝不能冒泡到已经成功执行的语句上，
   * 否则用户会看到「DDL 报错」而库里其实已经改完了。
   */
  it('历史写入失败不抛出', () => {
    const history: any = { add: async () => { throw new Error('storage full'); } };
    const observer = new QueryHistoryRecorder(conn, history).observer();
    expect(() => observer({ sql: 'DROP TABLE t', costTime: 1, rowCount: 0 })).not.toThrow();
  });
});
