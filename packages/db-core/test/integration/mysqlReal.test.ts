import { describe, expect, it } from 'vitest';
import { createPool, createConnection } from 'mysql2/promise';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';
import { parseNoBackslashEscapes } from '../../src/sql/index';
import { resolveTestDb, parseMysqlUrl } from './testDb.js';


/**
 * 真实 MySQL（独立测试库）上的 db-core 方言行为验证。
 *
 * 表在测试库内临时创建，结束后 DROP。门禁：MYSQL_TEST_URL
 * （形如 mysql://user:pass@host:port，密码百分号编码；库名 dbclient_verify）。
 * 未设置整体跳过，保证 CI 在无库机器通过。
 */
const URL = process.env.MYSQL_TEST_URL;


const DB = URL ? resolveTestDb() : 'skipped';

describe.skipIf(!URL)('db-core MySQL dialect (real db)', () => {
  it('F 项回归：varchar 列填入数字的筛选，必须精确字符串比较', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = createPool({ host, port, user, password, database: DB, waitForConnections: true, connectionLimit: 4 });
    const T = `z_verify_f_${Date.now()}`;
    const qT = `\`${T}\``;

    await pool.query(`CREATE TABLE ${qT} (id varchar(20) PRIMARY KEY, extra varchar(20))`);
    try {
      for (const [id, extra] of [['1', 'exact'], ['01', 'leading-zero'], [' 1', 'spaced'], ['1abc', 'suffix']] as const) {
        await pool.query(`INSERT INTO ${qT} (id, extra) VALUES (?, ?)`, [id, extra]);
      }

      const dialect = new MysqlDialect();
      // 修复后：type-aware 把 varchar(id) 的值加引号 → id = '1'
      const fixedSql = `SELECT id FROM ${qT} WHERE ${dialect.wrap('id')} = '1'`;
      const [fixed]: any[] = await pool.query(fixedSql);
      expect(fixed.map((r: any) => r.id)).toEqual(['1']);

      // 修复前形态：裸数字 id = 1 → MySQL 把列转 double，命中 1/01/ 1/1abc
      const brokenSql = `SELECT id FROM ${qT} WHERE ${dialect.wrap('id')} = 1`;
      const [broken]: any[] = await pool.query(brokenSql);
      expect(broken.map((r: any) => r.id).sort()).toEqual([' 1', '01', '1', '1abc']);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${qT}`);
      await pool.end();
    }
  });

  it('escapeValue 写读往返：反斜杠、引号、日期、NULL 经方言转义后读写一致', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = createPool({ host, port, user, password, database: DB, waitForConnections: true, connectionLimit: 4, dateStrings: true });
    const T = `z_verify_esc_${Date.now()}`;
    const qT = `\`${T}\``;
    await pool.query(`CREATE TABLE ${qT} (id INT PRIMARY KEY, s varchar(255), d date, n int NULL) ENGINE=InnoDB`);
    try {
      const dialect = new MysqlDialect();
      const samples = [
        { s: `a'b\\c`, d: '2024-01-15', n: null },
        { s: `50% _ underscore`, d: '2024-12-31', n: 7 },
        { s: '', d: '2024-06-01', n: 0 },
      ];
      for (let i = 0; i < samples.length; i++) {
        const { s, d, n } = samples[i];
        const esc = (v: any) => dialect.escapeValue(v);
        await pool.query(
          `INSERT INTO ${qT} (id, s, d, n) VALUES (${esc(i)}, ${esc(s)}, ${esc(d)}, ${n === null ? 'NULL' : esc(n)})`,
        );
      }
      const [rows]: any[] = await pool.query(
        `SELECT s, d, n FROM ${qT} ORDER BY id`,
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({ s: `a'b\\c`, d: '2024-01-15', n: null });
      expect(rows[1]).toEqual({ s: `50% _ underscore`, d: '2024-12-31', n: 7 });
      expect(rows[2]).toEqual({ s: '', d: '2024-06-01', n: 0 });
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${qT}`);
      await pool.end();
    }
  });

  /**
   * 真实库反斜杠往返（P1 批次核心验证）。
   *
   * 修复前 backupService / dataDiffService / dataTransferService / mockValue
   * 四处自建转义只处理单引号，`C:\tmp` 写进 MySQL 会被当转义符解释：
   * 实测字符码 92,116（\ t）→ 9（TAB），HEX 从 433A5C746D70 变成 433A096D70。
   * 现在全部走 dialect.escapeValue，反斜杠翻倍后写入必须与原值逐字节一致。
   */
  it('反斜杠经 dialect.escapeValue 写入后逐字节一致（修复前会变成 TAB）', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = createPool({ host, port, user, password, database: DB, waitForConnections: true, connectionLimit: 4 });
    const T = `z_verify_bs_${Date.now()}`;
    const qT = `\`${T}\``;
    await pool.query(`CREATE TABLE ${qT} (id INT PRIMARY KEY, s varchar(255)) ENGINE=InnoDB`);
    try {
      const dialect = new MysqlDialect();
      const samples = [
        'C:' + String.fromCharCode(92) + 'tmp',                    // C:\tmp -> 曾变 TAB
        'a' + String.fromCharCode(92) + 'nb',                      // a\nb   -> 曾变换行
        String.fromCharCode(92) + String.fromCharCode(92),         // \\
        "O'Brien" + String.fromCharCode(92),                       // 引号 + 反斜杠
        String.fromCharCode(92) + "'; DROP TABLE x; --",           // 注入形状
      ];
      for (let i = 0; i < samples.length; i++) {
        await pool.query(`INSERT INTO ${qT} (id, s) VALUES (${dialect.escapeValue(i)}, ${dialect.escapeValue(samples[i])})`);
      }
      const [rows]: any[] = await pool.query(`SELECT id, s FROM ${qT} ORDER BY id`);
      expect(rows).toHaveLength(samples.length);
      for (let i = 0; i < samples.length; i++) {
        // 逐字符码比对，避免字符串相等被隐式转换掩盖
        expect([...rows[i].s].map((c: string) => c.charCodeAt(0)))
          .toEqual([...samples[i]].map((c) => c.charCodeAt(0)));
      }
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${qT}`);
      await pool.end();
    }
  });

  /** 真实库确认表注释现在能读到（修复前 getTableListSql 漏 TABLE_COMMENT，恒为空）。 */
  it('getTableListSql 返回表注释（修复前恒为空）', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = createPool({ host, port, user, password, database: DB, waitForConnections: true, connectionLimit: 4 });
    const T = `z_verify_cmt_${Date.now()}`;
    const qT = `\`${T}\``;
    await pool.query(`CREATE TABLE ${qT} (id INT) COMMENT='表注释回归'`);
    try {
      const dialect = new MysqlDialect();
      const [rows]: any[] = await pool.query(dialect.getTableListSql(DB));
      const parsed = dialect.parseTableList(rows);
      const mine = parsed.find((t: any) => t.name === T);
      expect(mine).toBeDefined();
      expect(mine!.comment).toBe('表注释回归');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${qT}`);
      await pool.end();
    }
  });

  it('mysql 方言 parseIndexList：索引列聚合正确、is_unique/is_primary 归一', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const pool = createPool({ host, port, user, password, database: DB, waitForConnections: true, connectionLimit: 4 });
    const T = `z_verify_idx_${Date.now()}`;
    const qT = `\`${T}\``;
    await pool.query(`CREATE TABLE ${qT} (id INT NOT NULL, code varchar(20), PRIMARY KEY (id), UNIQUE KEY uq_code (code)) ENGINE=InnoDB`);
    try {
      const dialect = new MysqlDialect();
      const sql = dialect.getIndexListSql(T, DB);
      const [defs]: any[] = await pool.query(sql);

      const parsed = dialect.parseIndexList(defs as any);
      const byName = new Map(parsed.map((p: any) => [p.name, p]));
      expect(byName.has('PRIMARY')).toBe(true);
      expect(byName.get('PRIMARY').isPrimary).toBe(true);
      expect(byName.get('PRIMARY').isUnique).toBe(true);
      expect(byName.get('uq_code').isUnique).toBe(true);
      expect(byName.get('uq_code').columns).toEqual(['code']);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${qT}`);
      await pool.end();
    }
  });
}, 30_000);

/**
 * NO_BACKSLASH_ESCAPES 真库验证。
 *
 * 默认 MySQL 服务端 sql_mode 不含该模式，所以这条用例在**专用单连接**上
 * 显式 `SET SESSION sql_mode` 打开它，模拟管理员配置了该模式的服务器：
 * 反斜杠不再是转义符，值转义必须只靠 `''`，否则 `C:\tmp` 会被写成 `C:\\tmp`
 * （库里存两个反斜杠）。会话级设置只影响本连接，不会污染其它测试。
 */
describe.skipIf(!URL)('db-core MySQL NO_BACKSLASH_ESCAPES (real db, session)', () => {
  it('session 打开 NBE 后 escapeValue 写读逐字节一致，且 parse 识别该模式', async () => {
    const { host, port, user, password } = parseMysqlUrl(URL!);
    const conn = await createConnection({ host, port, user, password, database: DB });
    const T = `z_verify_nbe_${Date.now()}`;
    const qT = `\`${T}\``;
    try {
      await conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')");
      const [modeRows]: any[] = await conn.query('SELECT @@sql_mode AS mode');
      const mode = String((modeRows[0] as any).mode ?? '');
      expect(parseNoBackslashEscapes(mode)).toBe(true);

      const dialect = new MysqlDialect({ noBackslashEscapes: parseNoBackslashEscapes(mode) });
      await conn.query(`CREATE TABLE ${qT} (id INT PRIMARY KEY, s varchar(255)) ENGINE=InnoDB`);
      const samples = [
        'C:' + String.fromCharCode(92) + 'tmp',
        'a' + String.fromCharCode(92) + 'nb',
        String.fromCharCode(92) + String.fromCharCode(92),
        "O'Brien" + String.fromCharCode(92),
        String.fromCharCode(92) + "'; DROP TABLE x; --",
      ];
      for (let i = 0; i < samples.length; i++) {
        await conn.query(`INSERT INTO ${qT} (id, s) VALUES (${dialect.escapeValue(i)}, ${dialect.escapeValue(samples[i])})`);
      }
      const [rows]: any[] = await conn.query(`SELECT id, s FROM ${qT} ORDER BY id`);
      expect(rows).toHaveLength(samples.length);
      for (let i = 0; i < samples.length; i++) {
        expect([...rows[i].s].map((c: string) => c.charCodeAt(0)))
          .toEqual([...samples[i]].map((c) => c.charCodeAt(0)));
      }
    } finally {
      await conn.query(`DROP TABLE IF EXISTS ${qT}`).catch(() => { /* best-effort cleanup */ });
      await conn.end();
    }
  });
}, 30_000);