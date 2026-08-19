import { describe, expect, it } from 'vitest';
import { createPool } from 'mysql2/promise';
import { initSchema } from '../../src/repository/mysql/schema.js';
import { MysqlAdminAuditRepo } from '../../src/repository/mysql/adminAuditRepo.js';
import { MysqlUserRepo } from '../../src/repository/mysql/userRepo.js';

/**
 * 真库验证审计表与 countAdmins。
 *
 * 桩测试守得住 detail 的形状，守不住 `detail TEXT` 存进去再读出来还是不是
 * 同一个对象、`countAdmins` 的 WHERE 是否真的过滤了 status。
 */
const URL = process.env.MYSQL_TEST_URL;
const DB_NAME = process.env.MYSQL_TEST_DB || 'dbclient_verify';

function hostFrom(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`bad MYSQL_TEST_URL: ${url}`);
  const [, user, encPwd, host, port] = m;
  return { host, port: port ? Number(port) : 3306, user: decodeURIComponent(user), password: decodeURIComponent(encPwd) };
}

describe.skipIf(!URL)('admin_audit_log 与 countAdmins（isolated test db）', () => {
  async function freshPool() {
    const { host, port, user, password } = hostFrom(URL!);
    return createPool({ host, port, user, password, database: DB_NAME, waitForConnections: true, connectionLimit: 5 });
  }

  const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it('initSchema 建出 admin_audit_log 与三个索引，且幂等', async () => {
    const pool = await freshPool();
    try {
      await initSchema({ mysql: pool, log: console } as any);
      const [cols]: any = await pool.query('SHOW COLUMNS FROM admin_audit_log');
      const names = cols.map((c: any) => c.Field).sort();
      expect(names).toEqual([
        'action', 'actor_email', 'actor_user_id', 'create_time',
        'detail', 'id', 'ip', 'target_id', 'target_type',
      ]);

      /**
       * 表必须是 utf8mb4，**不能**继承库的默认字符集。
       *
       * 这个测试库 dbclient_verify 刻意保持 utf8mb3（阿里云 RDS 的
       * character_set_server 就是 utf8mb3），正好复现「DBA 预建库、部署账号
       * 没有建库权限」的生产形态。表继承成 utf8mb3 的后果不是乱码，而是
       * 用户名/连接名里带 emoji 时写入直接报错。
       */
      const [tinfo]: any = await pool.query(
        `SELECT table_collation c FROM information_schema.tables
          WHERE table_schema = ? AND table_name = 'admin_audit_log'`,
        [DB_NAME],
      );
      expect(String(tinfo[0].c)).toMatch(/^utf8mb4/);

      const [idx]: any = await pool.query('SHOW INDEX FROM admin_audit_log');
      const keys = [...new Set(idx.map((i: any) => i.Key_name))].sort();
      expect(keys).toEqual(['PRIMARY', 'idx_aal_actor', 'idx_aal_target', 'idx_aal_time']);

      /**
       * actor_user_id 刻意**没有**外键：用户被删之后留痕必须还在 ——
       * 「谁删了这个账号」正是最需要追溯的一类操作。
       */
      const [fks]: any = await pool.query(
        `SELECT constraint_name FROM information_schema.key_column_usage
          WHERE table_schema = ? AND table_name = 'admin_audit_log'
            AND referenced_table_name IS NOT NULL`,
        [DB_NAME],
      );
      expect(fks).toEqual([]);

      await initSchema({ mysql: pool, log: console } as any);
    } finally {
      await pool.end();
    }
  });

  it('detail 往返：写进去的对象读出来一模一样', async () => {
    const pool = await freshPool();
    const repo = new MysqlAdminAuditRepo(() => pool as any);
    const marker = `audit-rt-${tag()}`;
    try {
      const detail = {
        role: { from: 'user', to: 'admin' },
        // 特殊字符与中文都要能原样存取（TEXT + utf8mb4）
        note: `双引号" 反斜杠\\ 换行\n emoji🙂`,
        nested: { a: [1, 2, 3], b: null },
      };
      await repo.record({
        actorUserId: 999999, actorEmail: 'root@example.com',
        action: marker, targetType: 'user', targetId: '42', detail, ip: '203.0.113.9',
      });

      const [rows]: any = await pool.query('SELECT * FROM admin_audit_log WHERE action = ?', [marker]);
      expect(rows).toHaveLength(1);
      const back = JSON.parse(rows[0].detail);
      expect(back).toEqual(detail);
      expect(rows[0].actor_user_id).toBe(999999);
      expect(rows[0].ip).toBe('203.0.113.9');
    } finally {
      await pool.query('DELETE FROM admin_audit_log WHERE action = ?', [marker]);
      await pool.end();
    }
  });

  /**
   * 一条写坏的 detail 不能让整个列表接口 500 —— 这张表的用途正是「出事之后
   * 拿来看」，那时候最不需要的就是列表打不开。
   */
  it('detail 不是合法 JSON 时列表仍可读', async () => {
    const pool = await freshPool();
    const repo = new MysqlAdminAuditRepo(() => pool as any);
    const marker = `audit-bad-${tag()}`;
    try {
      await pool.query(
        `INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, detail)
         VALUES (?, ?, 'user', '1', ?)`,
        [1, marker, 'not-json{'],
      );
      const rows = await repo.list(200, 0);
      const bad = rows.find((r) => r.action === marker);
      expect(bad).toBeDefined();
      expect(bad!.detail).toEqual({ unparsed: 'not-json{' });
    } finally {
      await pool.query('DELETE FROM admin_audit_log WHERE action = ?', [marker]);
      await pool.end();
    }
  });

  it('countAdmins 只数 active 的 admin', async () => {
    const pool = await freshPool();
    const repo = new MysqlUserRepo(() => pool as any);
    const ids: number[] = [];
    const t = tag();
    try {
      let seq = 0;
      const mk = async (role: string, status: string) => {
        const [r]: any = await pool.query(
          'INSERT INTO users (email, password_hash, role, status, plan_code) VALUES (?, ?, ?, ?, ?)',
          [`ca-${role}-${status}-${++seq}-${t}@dbclient.dev`, 'not-used', role, status, 'free'],
        );
        ids.push(r.insertId);
        return r.insertId as number;
      };
      const base = await repo.countAdmins();
      await mk('admin', 'active');
      expect(await repo.countAdmins()).toBe(base + 1);
      // 被禁用的 admin 登不进来，不能算作「还有人能管」
      await mk('admin', 'disabled');
      expect(await repo.countAdmins()).toBe(base + 1);
      await mk('user', 'active');
      expect(await repo.countAdmins()).toBe(base + 1);
      await mk('admin', 'active');
      expect(await repo.countAdmins()).toBe(base + 2);
    } finally {
      for (const id of ids) await pool.query('DELETE FROM users WHERE id = ?', [id]);
      await pool.end();
    }
  });
}, 60_000);
