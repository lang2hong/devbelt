import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeSqlRisk } from '../../src/utils/sqlRisk';
import { confirmSqlExecution, ensureWritable } from '../../src/utils/sqlSafety';

/** 记录 vscode 弹窗调用，供断言「是否弹了模态」。 */
const shown = {
  errors: [] as string[],
  warnings: [] as { message: string; modal: boolean }[],
};
/** showWarningMessage 的返回值（模拟用户点了确认按钮或取消）。 */
let warningAnswer: string | undefined;

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: (msg: string) => { shown.errors.push(msg); },
    showWarningMessage: (msg: string, opts?: any, action?: string) => {
      shown.warnings.push({ message: msg, modal: Boolean(opts?.modal) });
      return Promise.resolve(warningAnswer === '__ACTION__' ? action : warningAnswer);
    },
  },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

function conn(over: Record<string, unknown> = {}): any {
  return {
    id: 'c1', name: 'prod-db', host: 'h', dbType: 'MYSQL',
    readOnly: false, environment: 'development', ...over,
  };
}

beforeEach(() => {
  shown.errors = [];
  shown.warnings = [];
  warningAnswer = undefined;
});

describe('analyzeSqlRisk', () => {
  it('allows read-only statements', () => {
    expect(analyzeSqlRisk('SELECT * FROM users')).toEqual({ level: 'none', isWrite: false });
  });

  it('marks an UPDATE without WHERE as critical', () => {
    expect(analyzeSqlRisk('UPDATE users SET enabled = 0')).toMatchObject({
      level: 'critical',
      isWrite: true,
      reason: 'UPDATE or DELETE without WHERE',
    });
  });

  it('marks DDL as critical after stripping comments', () => {
    expect(analyzeSqlRisk('-- cleanup\nDROP TABLE users')).toMatchObject({
      level: 'critical',
      reason: 'DDL or permission change',
    });
  });

  it('detects writes anywhere in an imported SQL script', () => {
    expect(analyzeSqlRisk('SELECT * FROM users; INSERT INTO audit_log VALUES (1)')).toMatchObject({
      level: 'write',
      isWrite: true,
    });
  });
  /**
   * 回归：字符串字面量里的关键字不得触发分类。
   *
   * 分类是全文 `\b关键字\b` 匹配，不做语法分析。曾把字面量一起看，
   * `SELECT 'DROP TABLE users'` 被判 critical + isWrite；而 confirmSqlExecution
   * 在 isWrite 为真时不早退，只读连接会直接报错拦截 —— 纯 SELECT 被禁止执行。
   */
  describe('字符串字面量中的关键字不参与分类', () => {
    const readOnlyCases = [
      "SELECT 'DROP TABLE users' AS note",
      "SELECT * FROM t WHERE name = 'ALTER'",
      "SELECT * FROM t WHERE sql_text = 'INSERT INTO x VALUES (1)'",
      `SELECT "DELETE FROM y" AS quoted`,
      "SELECT * FROM logs WHERE msg LIKE '%TRUNCATE%'",
      "SELECT 'GRANT ALL' , 'REVOKE ALL'",
    ];

    for (const sql of readOnlyCases) {
      it(`判为只读: ${sql.slice(0, 44)}`, () => {
        expect(analyzeSqlRisk(sql)).toEqual({ level: 'none', isWrite: false });
      });
    }

    it('反引号标识符里的关键字也不参与分类', () => {
      expect(analyzeSqlRisk('SELECT `drop` FROM `alter`')).toEqual({ level: 'none', isWrite: false });
    });

    it('MySQL 反斜杠转义不会提前结束字面量', () => {
      expect(analyzeSqlRisk("SELECT 'it\\'s DROP TABLE' AS s")).toEqual({ level: 'none', isWrite: false });
    });

    it('PG/SQLite 双写引号的字面量同样被剥离', () => {
      expect(analyzeSqlRisk("SELECT 'O''Brien DROP TABLE' AS s")).toEqual({ level: 'none', isWrite: false });
    });

    it('# 行注释里的关键字被剥离（MySQL 显式开启 hashComment）', () => {
      expect(analyzeSqlRisk('SELECT 1 # DROP TABLE users', { hashComment: true })).toEqual({ level: 'none', isWrite: false });
    });

    /**
     * 回归：PG 里 `#` 是运算符，不能按注释处理。默认方言下
     * `SELECT 1 # 2; DROP TABLE t` 的 DROP 必须可见（PG simple query 会执行两条）。
     */
    it('默认方言下 # 是代码，其后的写必须可见（防 PG 只读绕过）', () => {
      expect(analyzeSqlRisk('SELECT 1 # 2; DROP TABLE t')).toMatchObject({
        level: 'critical', isWrite: true,
      });
      expect(analyzeSqlRisk('SELECT 1 # DROP TABLE users')).toMatchObject({ isWrite: true });
    });

    /**
     * 回归：分类器与切分器曾对 `#` 注释规则不一致，导致
     * `SELECT 1 #; DROP TABLE users` 被判只读、切分后仍执行 DROP。
     * 两者现在共用 `@db-client/core/sql` 的 lexer；这里锁定分类侧仍把 `#` 后内容视为注释。
     */
    it('MySQL 可执行注释 /*! */ 内的写必须被识别，不得当惰性注释', () => {
      expect(analyzeSqlRisk('/*!50000 DROP TABLE users */')).toMatchObject({
        level: 'critical', isWrite: true,
      });
    });

    it('追加带 WHERE 的语句不能把前面的 DELETE 从 critical 降级', () => {
      expect(analyzeSqlRisk('DELETE FROM users; SELECT 1 WHERE 1=0')).toMatchObject({
        level: 'critical', isWrite: true, reason: 'UPDATE or DELETE without WHERE',
      });
    });

    it('剥离字面量后真实的写操作仍被识别', () => {
      expect(analyzeSqlRisk("INSERT INTO t (note) VALUES ('SELECT 1')")).toMatchObject({
        level: 'write', isWrite: true,
      });
      expect(analyzeSqlRisk("DROP TABLE t /* keep 'SELECT' */")).toMatchObject({
        level: 'critical', reason: 'DDL or permission change',
      });
      expect(analyzeSqlRisk("UPDATE t SET note = 'WHERE'")).toMatchObject({
        level: 'critical', reason: 'UPDATE or DELETE without WHERE',
      });
    });

    it('字面量替换为空格，不会粘连成新词', () => {
      // 若删除而非替空格，'DROP' + 'TABLE' 会拼成 DROPTABLE 之类的意外词
      expect(analyzeSqlRisk("SELECT 'a'||'b' FROM t")).toEqual({ level: 'none', isWrite: false });
    });

    it('未闭合的字面量不会吞掉后续语句判定（保守到行尾）', () => {
      // 未闭合引号后全部视为字面量，结果是 SELECT 部分保留 → 只读
      expect(analyzeSqlRisk("SELECT 'unterminated")).toEqual({ level: 'none', isWrite: false });
    });
  });
});

/**
 * 只读连接闸门。这是「只读」这个能力边界的**唯一**实现点，
 * 树右键的 DDL 命令刻意不弹确认框，只靠它守住。
 */
describe('ensureWritable', () => {
  it('可写连接放行且不提示', () => {
    expect(ensureWritable(conn())).toBe(true);
    expect(shown.errors).toEqual([]);
  });

  it('只读连接拦截并提示连接名', () => {
    expect(ensureWritable(conn({ readOnly: true }))).toBe(false);
    expect(shown.errors).toHaveLength(1);
    expect(shown.errors[0]).toContain('prod-db');
  });

  it('无 name 时回退用 host 提示', () => {
    expect(ensureWritable(conn({ readOnly: true, name: undefined, host: '10.0.0.1' }))).toBe(false);
    expect(shown.errors[0]).toContain('10.0.0.1');
  });
});

describe('confirmSqlExecution', () => {
  it('只读语句直接放行，不查只读标记也不弹窗', async () => {
    // 注意顺序：isWrite 判定先于 ensureWritable，所以只读连接上的 SELECT 必须能跑
    await expect(confirmSqlExecution(conn({ readOnly: true }), 'SELECT * FROM users')).resolves.toBe(true);
    expect(shown.errors).toEqual([]);
    expect(shown.warnings).toEqual([]);
  });

  it('只读连接上的写语句被拦截', async () => {
    await expect(confirmSqlExecution(conn({ readOnly: true }), "INSERT INTO t VALUES (1)")).resolves.toBe(false);
    expect(shown.errors).toHaveLength(1);
    expect(shown.warnings).toEqual([]);
  });

  it('开发环境的普通写语句无需确认', async () => {
    await expect(confirmSqlExecution(conn(), "INSERT INTO t VALUES (1)")).resolves.toBe(true);
    expect(shown.warnings).toEqual([]);
  });

  it('critical 语句弹模态，确认后放行', async () => {
    warningAnswer = '__ACTION__';
    await expect(confirmSqlExecution(conn(), 'DROP TABLE users')).resolves.toBe(true);
    expect(shown.warnings).toHaveLength(1);
    expect(shown.warnings[0].modal).toBe(true);
    expect(shown.warnings[0].message).toContain('DDL or permission change');
  });

  it('critical 语句弹模态，用户取消则拒绝', async () => {
    warningAnswer = undefined;
    await expect(confirmSqlExecution(conn(), 'DROP TABLE users')).resolves.toBe(false);
    expect(shown.warnings).toHaveLength(1);
  });

  it('生产连接上的普通写语句也要确认', async () => {
    warningAnswer = '__ACTION__';
    await expect(
      confirmSqlExecution(conn({ environment: 'production' }), 'INSERT INTO t VALUES (1)'),
    ).resolves.toBe(true);
    expect(shown.warnings).toHaveLength(1);
    expect(shown.warnings[0].modal).toBe(true);
  });

  it('生产连接 + 用户取消 → 拒绝', async () => {
    warningAnswer = 'Cancel';
    await expect(
      confirmSqlExecution(conn({ environment: 'production' }), 'INSERT INTO t VALUES (1)'),
    ).resolves.toBe(false);
  });

  it('只读优先于确认：只读的生产连接不弹窗直接拒', async () => {
    await expect(
      confirmSqlExecution(conn({ readOnly: true, environment: 'production' }), 'DROP TABLE t'),
    ).resolves.toBe(false);
    expect(shown.warnings).toEqual([]);
    expect(shown.errors).toHaveLength(1);
  });

  it('PG 只读连接：`#` 运算符后的 DROP 必须被拦截（不被当注释）', async () => {
    await expect(
      confirmSqlExecution(conn({ dbType: 'PG', readOnly: true }), 'SELECT 1 # 2; DROP TABLE t'),
    ).resolves.toBe(false);
    expect(shown.errors).toHaveLength(1);
  });
});

describe('过程体 / 美元引用 fail-closed（防 DO 逃逸）', () => {
  it('DO $$…DELETE…$$ 视为 critical（dollar 体不可静态判定）', () => {
    expect(analyzeSqlRisk('DO $$ BEGIN DELETE FROM users; END $$')).toMatchObject({
      level: 'critical', isWrite: true, reason: 'procedural or dynamic execution',
    });
  });

  it('CALL / EXECUTE 视为 critical', () => {
    expect(analyzeSqlRisk('CALL cleanup_all()')).toMatchObject({ level: 'critical', isWrite: true });
    expect(analyzeSqlRisk('EXECUTE stmt')).toMatchObject({ level: 'critical', isWrite: true });
  });

  it('仅含美元引用体的语句按写处理（fail-closed）', () => {
    expect(analyzeSqlRisk('SELECT $$x$$')).toMatchObject({ isWrite: true });
  });

  it('只读连接拦截 DO 过程体（不早退）', async () => {
    await expect(confirmSqlExecution(conn({ readOnly: true }), 'DO $$ BEGIN DELETE FROM users; END $$')).resolves.toBe(false);
    expect(shown.errors).toHaveLength(1);
  });
});
