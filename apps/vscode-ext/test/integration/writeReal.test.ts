import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConnectionFactory, DatabaseType, QueryService } from '@devbelt/db-core';
import type { ConnectionConfig } from '@devbelt/db-core';
import type { ExecutionLedger, LedgerEventInput, LedgerEvent } from '@devbelt/agent-core';
import { buildWriteTools } from '../../src/agent/writeTools';
import { exportMaskedTable } from '../../src/masking/export';

function parseMysqlUrl(url: string) {
  const m = /^mysql:\/\/([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error('bad DEVBELT_DB_TEST_MYSQL_URL');
  return { host: m[3]!, port: m[4] ? Number(m[4]) : 3306, user: decodeURIComponent(m[1]!), password: decodeURIComponent(m[2]!) };
}

function mysqlDb(): string {
  const name = (process.env.DEVBELT_DB_TEST_MYSQL_DB || 'devbelt_db_verify').trim();
  const prod = (process.env.DEVBELT_DB_MYSQL_DATABASE || '').trim();
  if (!name || (prod && name.toLowerCase() === prod.toLowerCase()) || !/verify|test/i.test(name)) {
    throw new Error(`refusing to use ${JSON.stringify(name)} for integration tests`);
  }
  return name;
}

async function open(dbType: DatabaseType, config: ConnectionConfig): Promise<QueryService> {
  const { connection, dialect } = ConnectionFactory.createWithDialect(dbType, config);
  await new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve())));
  return new QueryService(connection, dialect);
}

function memoryLedger(): ExecutionLedger & { events: LedgerEventInput[] } {
  const events: LedgerEventInput[] = [];
  return {
    events,
    async append(event) { events.push(event); return { ...event, v: 1, seq: events.length, at: 1 } as LedgerEvent; },
    async load() { return []; },
    async recoverInterrupted() { return []; },
  };
}

const MYSQL_URL = process.env.DEVBELT_DB_TEST_MYSQL_URL;
const PG_URL = process.env.DEVBELT_DB_TEST_PG_URL;
const STAMP = Date.now();
const sessions: QueryService[] = [];
afterAll(() => { for (const q of sessions.splice(0)) q.end(); });

describe.skipIf(!MYSQL_URL)('approved writes on real MySQL', () => {
  const table = `z_write_${STAMP}`;
  const ddlTable = `z_ddl_${STAMP}`;
  let q: QueryService;

  it('executes approved DML and DDL exactly once, and keeps the ledger terminal', async () => {
    q = await open(DatabaseType.MYSQL, { ...parseMysqlUrl(MYSQL_URL!), database: mysqlDb() });
    sessions.push(q);
    await q.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, v INT)`);
    await q.query(`INSERT INTO \`${table}\` VALUES (1, 10)`);
    const ledger = memoryLedger();
    let confirmations = 0;
    const tools = buildWriteTools({
      dbType: DatabaseType.MYSQL,
      target: { connectionId: 'c1', database: mysqlDb(), dialect: 'MYSQL' },
      connection: { readOnly: false, production: false },
      settings: { allowWrites: true, allowDdl: true, allowProduction: false },
      openSession: async () => ({ session: q, close: () => undefined }),
      confirm: async () => { confirmations += 1; return true; },
      ledger,
    });

    const dml = await tools.execute('propose_write', `UPDATE \`${table}\` SET v = 11 WHERE id = 1`, new AbortController().signal);
    expect(dml.summary).toBe('已执行，影响 1 行');
    const rows = await q.query(`SELECT v FROM \`${table}\` WHERE id = 1`);
    expect(rows.rows).toEqual([{ v: '11' }]);

    const ddl = await tools.execute('propose_ddl', `CREATE TABLE \`${ddlTable}\` (id INT PRIMARY KEY)`, new AbortController().signal);
    expect(ddl.isError).toBeUndefined();
    const exists = await q.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      [ddlTable],
    );
    expect(Number((exists.rows[0] as { n: unknown }).n)).toBe(1);

    expect(confirmations).toBe(2);
    expect(ledger.events.filter((e) => e.state === 'SUCCEEDED')).toHaveLength(2);
    expect(ledger.events.at(-1)!.state).toBe('SUCCEEDED');
  }, 60_000);

  it('refuses production writes even when writes are enabled', async () => {
    if (!q) return;
    const ledger = memoryLedger();
    const tools = buildWriteTools({
      dbType: DatabaseType.MYSQL,
      target: { connectionId: 'c1', database: mysqlDb(), dialect: 'MYSQL' },
      connection: { readOnly: false, production: true },
      settings: { allowWrites: true, allowDdl: true, allowProduction: false },
      openSession: async () => ({ session: q, close: () => undefined }),
      confirm: async () => true,
      ledger,
    });
    const out = await tools.execute('propose_write', `UPDATE \`${table}\` SET v = 99`, new AbortController().signal);
    expect(out).toMatchObject({ isError: true, errorCode: 'production_denied' });
    expect(ledger.events).toEqual([]);
    const rows = await q.query(`SELECT v FROM \`${table}\` WHERE id = 1`);
    expect(rows.rows).toEqual([{ v: '11' }]);
  });
});

describe.skipIf(!PG_URL)('approved writes on real PostgreSQL', () => {
  const schema = `ztest_write_${STAMP}`;
  let q: QueryService;

  it('executes approved DML and leaves the ledger terminal', async () => {
    q = await open(DatabaseType.PG, { host: '', port: 0, user: '', useConnectionString: true, connectionUrl: PG_URL!, schema });
    sessions.push(q);
    await q.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await q.query(`CREATE TABLE ${schema}.t (id int PRIMARY KEY, v int)`);
    await q.query(`INSERT INTO ${schema}.t VALUES (1, 10)`);
    const ledger = memoryLedger();
    const tools = buildWriteTools({
      dbType: DatabaseType.PG,
      target: { connectionId: 'c1', database: 'verify', schema, dialect: 'PG' },
      connection: { readOnly: false, production: false },
      settings: { allowWrites: true, allowDdl: false, allowProduction: false },
      openSession: async () => ({ session: q, close: () => undefined }),
      confirm: async () => true,
      ledger,
    });
    const out = await tools.execute('propose_write', 'UPDATE t SET v = 12 WHERE id = 1', new AbortController().signal);
    expect(out.summary).toBe('已执行，影响 1 行');
    const rows = await q.query('SELECT v FROM t WHERE id = 1');
    expect(rows.rows).toEqual([{ v: 12 }]);
    expect(ledger.events.map((e) => e.state)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED']);
  }, 60_000);
});

describe('masked export sanity', () => {
  it('rejects PII without a rule (no database needed)', async () => {
    const q = { query: vi.fn() } as never;
    await expect(exportMaskedTable({
      query: q,
      dialect: { dbType: DatabaseType.SQLITE, wrap: (s: string) => s } as never,
      metadata: { getColumns: async () => [{ name: 'email', isNotNull: false, isUnique: false, maxLength: '10', isPrimary: false } as never] },
      table: 't', columns: {}, salt: 's', maxRows: 10,
    }, 'csv', '/tmp/never.csv', 10)).rejects.toThrow(/PII/);
  });
});