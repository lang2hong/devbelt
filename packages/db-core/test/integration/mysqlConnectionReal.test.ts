import { describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { MysqlConnection } from '../../src/connection/mysqlConnection';
import { QueryService } from '../../src/query/queryService';
import { MysqlDialect } from '../../src/dialect/mysqlDialect';

/**
 * 真实 MySQL 上验证连接适配器的两件事：
 *  - 二进制列往返不损坏（mock 只能证明返回了 Buffer，不能证明字节没被驱动改过）
 *  - 取消查询走 KILL QUERY 之后连接**仍然可用**（这是修复的全部意义）
 *
 * 门禁：MYSQL_TEST_URL。
 */
const URL = process.env.MYSQL_TEST_URL;
const DB = process.env.MYSQL_TEST_DB || 'dbclient_verify';

function hostFrom(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`bad MYSQL_TEST_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return { host, port: port ? Number(port) : 3306, user: decodeURIComponent(user), password: decodeURIComponent(encPwd) };
}

describe.skipIf(!URL)('MysqlConnection 真库行为', () => {
  const cfg = () => ({ ...hostFrom(URL!), database: DB, connectTimeout: 8000 });

  function svc() {
    const con = new MysqlConnection(cfg());
    return { con, q: new QueryService(con, new MysqlDialect()) };
  }

  async function connect(con: MysqlConnection) {
    await new Promise<void>((res, rej) => con.connect((e) => (e ? rej(e) : res())));
  }

  /**
   * BLOB 往返。
   *
   * 原实现对一切非日期列走 `buf.toString()`（默认 UTF-8）：0x00 0xFF 0xFE
   * 这类不合法的 UTF-8 序列会被替换成 U+FFFD，**不可逆**。结果网格里编辑
   * 一行再保存，写回库的就是被替换过的字节。
   */
  it('BLOB 列字节原样返回，不被 UTF-8 替换字符污染', async () => {
    const T = `z_blob_${Date.now()}`;
    const admin = await createConnection({ ...cfg() });
    const { con, q } = svc();
    await connect(con);
    try {
      await admin.query(`CREATE TABLE \`${T}\` (id INT PRIMARY KEY, payload BLOB, txt VARCHAR(50))`);
      // 刻意包含非法 UTF-8 字节与 NUL
      const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x80, 0xc3, 0x28]);
      await admin.query(`INSERT INTO \`${T}\` VALUES (1, ?, ?)`, [raw, 'héllo']);

      const res = await q.query(`SELECT payload, txt FROM \`${T}\` WHERE id = 1`);
      const row: any = res.rows[0];
      expect(Buffer.isBuffer(row.payload), 'BLOB 应为 Buffer').toBe(true);
      expect((row.payload as Buffer).equals(raw)).toBe(true);
      // 文本列仍是字符串且未被破坏
      expect(row.txt).toBe('héllo');
    } finally {
      await admin.query(`DROP TABLE IF EXISTS \`${T}\``);
      await admin.end();
      con.end();
    }
  }, 30_000);

  it('BIGINT 以字符串返回，不丢精度', async () => {
    const T = `z_big_${Date.now()}`;
    const admin = await createConnection({ ...cfg() });
    const { con, q } = svc();
    await connect(con);
    try {
      await admin.query(`CREATE TABLE \`${T}\` (id BIGINT PRIMARY KEY)`);
      await admin.query(`INSERT INTO \`${T}\` VALUES (1234567890123456789)`);
      const res = await q.query(`SELECT id FROM \`${T}\``);
      expect(String((res.rows[0] as any).id)).toBe('1234567890123456789');
    } finally {
      await admin.query(`DROP TABLE IF EXISTS \`${T}\``);
      await admin.end();
      con.end();
    }
  }, 30_000);

  /**
   * 这条是批 16 的核心：取消之后连接必须还能用。
   *
   * 原实现 `abortQuery()` 是 `con.destroy()` —— 而一个会话里 QueryService /
   * MetadataService / DataService / TableService 共用同一条 IConnection，
   * 所以默认 30 秒的查询超时一到，整条连接就废了：树视图、补全、后续查询
   * 全部失败，用户看到的是"查询超时之后连接莫名坏了"。
   */
  it('取消慢查询后，同一条连接仍可继续执行', async () => {
    const { con, q } = svc();
    await connect(con);
    try {
      // SLEEP(10) 足够长，保证取消发生在它返回之前
      const slow = q.query('SELECT SLEEP(10)');
      // 等一小会儿让语句真正开始执行，否则 KILL QUERY 可能打在空档上
      await new Promise((r) => setTimeout(r, 500));
      expect(q.cancel()).toBe(true);
      await expect(slow).rejects.toThrow(/cancel/i);

      // 关键断言：连接没被销毁，还能继续用
      expect(con.isAlive()).toBe(true);
      const after = await q.query('SELECT 1 AS ok');
      expect(String((after.rows[0] as any).ok)).toBe('1');
    } finally {
      con.end();
    }
  }, 30_000);

  it('查询超时同样不废掉连接', async () => {
    const old = QueryService.queryTimeout;
    QueryService.queryTimeout = 1200;
    const { con, q } = svc();
    await connect(con);
    try {
      await expect(q.query('SELECT SLEEP(10)')).rejects.toThrow(/timeout/i);
      expect(con.isAlive()).toBe(true);
      const after = await q.query('SELECT 2 AS ok');
      expect(String((after.rows[0] as any).ok)).toBe('2');
    } finally {
      QueryService.queryTimeout = old;
      con.end();
    }
  }, 30_000);

  /**
   * KILL QUERY 是发给**服务端**的，所以那条 SLEEP 应该真的消失，
   * 而不是仅仅在客户端被忽略。
   */
  it('取消真的终止了服务端语句', async () => {
    const admin = await createConnection({ ...cfg() });
    const { con, q } = svc();
    await connect(con);
    try {
      const slow = q.query('SELECT SLEEP(10)');
      await new Promise((r) => setTimeout(r, 500));

      // 必须排除本条统计语句自己：它的 info 文本里就含 'SLEEP(10)'，
      // 不排除的话计数永远 >= 1，before/after 两个断言都会假绿。
      const countSleeping = async () => {
        const [r]: any = await admin.query(
          `SELECT COUNT(*) c FROM information_schema.processlist
            WHERE command = 'Query' AND id <> CONNECTION_ID()
              AND info LIKE ?`,
          ['%SLEEP(10)%'],
        );
        return Number(r[0].c);
      };
      expect(await countSleeping()).toBeGreaterThanOrEqual(1);

      q.cancel();
      await slow.catch(() => {});
      // KILL 是异步生效的，给服务端一点时间
      await new Promise((r) => setTimeout(r, 800));

      expect(await countSleeping()).toBe(0);
    } finally {
      await admin.end();
      con.end();
    }
  }, 30_000);

  /**
   * 连接串模式必须与字段模式行为一致 —— 原实现在连接串模式下丢弃了
   * supportBigNumbers / dateStrings / typeCast，同一个库同一张表读出来的值
   * 会因为"连接方式"不同而不同。
   */
  it('连接串模式下精度与二进制行为与字段模式一致', async () => {
    const T = `z_url_${Date.now()}`;
    const admin = await createConnection({ ...cfg() });
    const { host, port, user, password } = hostFrom(URL!);
    const url = `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${DB}`;
    const con = new MysqlConnection({
      host, port, user, password, database: DB,
      useConnectionString: true, connectionUrl: url,
    });
    const q = new QueryService(con, new MysqlDialect());
    await connect(con);
    try {
      await admin.query(`CREATE TABLE \`${T}\` (id BIGINT PRIMARY KEY, payload BLOB, d DATETIME)`);
      const raw = Buffer.from([0x00, 0xff, 0x41]);
      await admin.query(`INSERT INTO \`${T}\` VALUES (1234567890123456789, ?, '2024-03-05 06:07:08')`, [raw]);

      const res = await q.query(`SELECT id, payload, d FROM \`${T}\``);
      const row: any = res.rows[0];
      expect(String(row.id)).toBe('1234567890123456789');
      expect(Buffer.isBuffer(row.payload)).toBe(true);
      expect((row.payload as Buffer).equals(raw)).toBe(true);
      // dateStrings：原始文本而不是 JS Date
      expect(typeof row.d).toBe('string');
      expect(String(row.d)).toContain('2024-03-05');
    } finally {
      await admin.query(`DROP TABLE IF EXISTS \`${T}\``);
      await admin.end();
      con.end();
    }
  }, 30_000);
});
