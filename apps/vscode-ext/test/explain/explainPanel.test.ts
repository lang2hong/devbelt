import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  clipboard: vi.fn(async () => undefined),
  diag: vi.fn(),
  info: vi.fn(),
  bridge: undefined as undefined | { requestChat: ReturnType<typeof vi.fn> },
}));

vi.mock('vscode', () => ({
  ViewColumn: { Beside: -2 },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en', clipboard: { writeText: h.clipboard } },
  window: { showInformationMessage: h.info },
}));

vi.mock('../../src/ai/aiBridge', () => ({ AiBridge: { tryGet: () => h.bridge } }));

vi.mock('../../src/result/baseWebView', () => ({
  BaseWebView: class {
    panel = { title: '' };
    post = vi.fn();
    initSent = false;
    constructor(..._args: unknown[]) { /* noop */ }
    dispose(): void { this.onDispose(); }
    reveal(): void { /* noop */ }
    onDispose(): void { /* noop */ }
  },
}));

vi.mock('../../src/utils/sqlSafety', () => ({ confirmSqlExecution: h.confirm }));
vi.mock('../../src/utils/diagnostics', () => ({ diagError: h.diag, diagWarn: vi.fn(), diagInfo: vi.fn() }));

import { ExplainPanel } from '../../src/explain/explainPanel';

const MYSQL_PLAN = { EXPLAIN: JSON.stringify({ query_block: { select_id: 1, table: { table_name: 'users', access_type: 'ALL', rows_examined_per_scan: 5000 } } }) };

type Handler = (sql: string) => unknown;

function makeManager(handler: Handler, metadata?: Record<string, unknown>) {
  const executed: string[] = [];
  const query = vi.fn(async (sql: string) => {
    executed.push(sql);
    const out = await handler(sql);
    return { rows: out ?? [] };
  });
  const isolatedClose = vi.fn();
  const manager: any = {
    retain: vi.fn(),
    release: vi.fn(),
    scanOptionsFor: () => undefined,
    connectSql: vi.fn(async () => ({ query: { query, wrap: (s: string) => `\`${s}\`` }, ...(metadata ? { metadata } : {}) })),
    openIsolatedSql: vi.fn(async () => ({
      session: { query: { query, wrap: (s: string) => `"${s}"` }, ...(metadata ? { metadata } : {}) },
      close: isolatedClose,
    })),
    isolatedClose,
  };
  return { manager, executed, query };
}

function conn(overrides: Record<string, unknown> = {}): any {
  return { id: 'c1', name: 'local', host: 'localhost', dbType: 'MYSQL', database: 'app', ...overrides };
}

function posts(view: any): any[] {
  return view.post.mock.calls.map((c: any[]) => c[0]);
}

async function mount(view: any): Promise<void> {
  await view.handleMessage({ type: 'ready' });
  await view.handleMessage({ type: 'ready' });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  ExplainPanel.closeAll();
  h.confirm.mockReset().mockResolvedValue(true);
  h.clipboard.mockClear();
  h.diag.mockClear();
  h.info.mockClear();
  h.bridge = undefined;
});

describe('ExplainPanel', () => {
  it('two-ready protocol: first ready sends init, second runs the plan', async () => {
    const { manager, executed } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn(), 'SELECT * FROM users');
    const view: any = ExplainPanel.find('c1');

    await view.handleMessage({ type: 'ready' });
    expect(posts(view)).toEqual([{ type: 'init', mode: 'explain' }]);
    expect(executed).toEqual([]);

    await view.handleMessage({ type: 'ready' });
    const plan = posts(view).find((m) => m.type === 'explainPlan');
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0].plan.roots[0].children[0].object).toBe('users');
    expect(executed).toContain('EXPLAIN FORMAT=JSON SELECT * FROM users');
  });

  it('falls back to conn.database for MySQL when no database is given', async () => {
    const { manager, executed } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn({ database: 'app' }), 'SELECT 1');
    await mount(ExplainPanel.find('c1'));
    expect(executed[0]).toBe('USE `app`');
  });

  it('prefers the explicit database over conn.database', async () => {
    const { manager, executed } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn({ database: 'app' }), 'SELECT 1', 'reporting');
    await mount(ExplainPanel.find('c1'));
    expect(executed[0]).toBe('USE `reporting`');
  });

  it('decodes the MySQL EXPLAIN column for the raw pane', async () => {
    const { manager } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn(), 'SELECT 1');
    const view: any = ExplainPanel.find('c1');
    await mount(view);
    const plan = posts(view).find((m) => m.type === 'explainPlan');
    expect(typeof plan.statements[0].plan.raw[0].EXPLAIN).toBe('object');
  });

  it('uses the legacy EXPLAIN as a fallback when the structured format fails', async () => {
    const { manager } = makeManager((sql) => {
      if (sql.includes('FORMAT=JSON')) throw new Error('FORMAT not supported');
      if (sql.startsWith('EXPLAIN')) return [{ id: 1, table: 'users', type: 'ALL' }];
      return [];
    });
    ExplainPanel.open(manager, conn(), 'SELECT 1');
    const view: any = ExplainPanel.find('c1');
    await mount(view);
    const plan = posts(view).find((m) => m.type === 'explainPlan');
    expect(plan.statements[0].plan).toBeNull();
    expect(plan.statements[0].fallback.reason).toBe('FORMAT not supported');
    expect(plan.statements[0].fallback.rows).toHaveLength(1);
  });

  it('reports the real error when both structured and legacy EXPLAIN fail', async () => {
    const { manager } = makeManager((sql) => {
      if (sql.startsWith('EXPLAIN')) throw new Error("Table 'app.nope' doesn't exist");
      return [];
    });
    ExplainPanel.open(manager, conn(), 'SELECT * FROM nope');
    const view: any = ExplainPanel.find('c1');
    await mount(view);
    expect(posts(view).some((m) => m.type === 'explainPlan')).toBe(false);
    expect(posts(view).at(-1)).toEqual({ type: 'error', message: "Table 'app.nope' doesn't exist" });
    expect(h.diag).toHaveBeenCalledWith('explain failed', "Table 'app.nope' doesn't exist");
  });

  it('discards an in-flight result when open() replaces the SQL', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { manager, executed } = makeManager(async (sql) => {
      if (sql.includes('old_t')) await gate;
      return [MYSQL_PLAN];
    });
    ExplainPanel.open(manager, conn({ database: undefined }), 'SELECT * FROM old_t');
    const view: any = ExplainPanel.find('c1');
    const first = mount(view);
    await flush();

    ExplainPanel.open(manager, conn({ database: undefined }), 'SELECT * FROM new_t');
    release();
    await first;
    await flush();

    const plans = posts(view).filter((m) => m.type === 'explainPlan');
    expect(plans).toHaveLength(1);
    expect(plans[0].statements[0].sql).toBe('SELECT * FROM new_t');
    expect(executed).toContain('EXPLAIN FORMAT=JSON SELECT * FROM new_t');
  });

  it('blocks SQL containing a password literal before connecting', async () => {
    const { manager } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn(), "ALTER USER 'a'@'%' IDENTIFIED BY 'secret'");
    const view: any = ExplainPanel.find('c1');
    await mount(view);
    expect(manager.connectSql).not.toHaveBeenCalled();
    expect(posts(view).at(-1)).toMatchObject({ type: 'error' });
  });

  it('does nothing when the safety confirmation is declined', async () => {
    h.confirm.mockResolvedValue(false);
    const { manager } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn(), 'DELETE FROM users');
    const view: any = ExplainPanel.find('c1');
    await mount(view);
    expect(manager.connectSql).not.toHaveBeenCalled();
    expect(posts(view).some((m) => m.type === 'explainRunning')).toBe(false);
  });

  it('omits the raw plan above the payload limit but keeps the tree', async () => {
    const big = { query_block: { select_id: 1, table: { table_name: 'users', access_type: 'ALL', attached_condition: 'x'.repeat(1_200_000) } } };
    const { manager } = makeManager(() => [{ EXPLAIN: JSON.stringify(big) }]);
    ExplainPanel.open(manager, conn(), 'SELECT 1');
    const view: any = ExplainPanel.find('c1');
    await mount(view);
    const stmt = posts(view).find((m) => m.type === 'explainPlan').statements[0];
    expect(stmt.rawTruncated).toBe(true);
    expect(stmt.plan.raw).toBeNull();
    expect(stmt.plan.roots[0].children[0].object).toBe('users');
  });

  it('reuses the panel per connection and releases the connection on dispose', async () => {
    const { manager } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn(), 'SELECT 1');
    const view: any = ExplainPanel.find('c1');
    ExplainPanel.open(manager, conn(), 'SELECT 2');
    expect(ExplainPanel.find('c1')).toBe(view);
    expect(manager.retain).toHaveBeenCalledTimes(1);

    view.dispose();
    expect(ExplainPanel.find('c1')).toBeUndefined();
    expect(manager.release).toHaveBeenCalledWith('c1');
  });

  it('copies raw text to the clipboard', async () => {
    const { manager } = makeManager(() => [MYSQL_PLAN]);
    ExplainPanel.open(manager, conn(), 'SELECT 1');
    const view: any = ExplainPanel.find('c1');
    await view.handleMessage({ type: 'copyText', text: '{"a":1}' });
    expect(h.clipboard).toHaveBeenCalledWith('{"a":1}');
  });

  describe('AI explain', () => {
    async function mounted(handler: Handler, sql = 'SELECT * FROM users'): Promise<any> {
      const { manager } = makeManager(handler);
      ExplainPanel.open(manager, conn(), sql);
      const view: any = ExplainPanel.find('c1');
      await mount(view);
      return view;
    }

    it('tells the user when AI is not enabled', async () => {
      const view = await mounted(() => [MYSQL_PLAN]);
      await view.handleMessage({ type: 'aiExplain', index: 0 });
      expect(h.info).toHaveBeenCalledTimes(1);
    });

    it('sends the normalized plan text under the optimize feature', async () => {
      h.bridge = { requestChat: vi.fn() };
      const view = await mounted(() => [MYSQL_PLAN]);
      await view.handleMessage({ type: 'aiExplain', index: 0 });

      expect(h.bridge.requestChat).toHaveBeenCalledTimes(1);
      const request = h.bridge.requestChat.mock.calls[0][0];
      expect(request).toMatchObject({ feature: 'optimize', connId: 'c1', connName: 'local' });
      const user = request.messages.at(-1).content as string;
      expect(user).toContain('SELECT * FROM users');
      expect(user).toContain('Table scan on users rows=5000');
      expect(user).toContain('Dialect: MYSQL');
      expect(user).not.toContain('query_block');
    });

    it('sends only the selected statement', async () => {
      h.bridge = { requestChat: vi.fn() };
      const view = await mounted(() => [MYSQL_PLAN], 'SELECT 1; SELECT 2');
      await view.handleMessage({ type: 'aiExplain', index: 1 });
      const user = h.bridge.requestChat.mock.calls[0][0].messages.at(-1).content as string;
      expect(user).toContain('SELECT 2');
      expect(user).not.toContain('SELECT 1');
    });

    it('sends raw text when only a fallback is available', async () => {
      h.bridge = { requestChat: vi.fn() };
      const view = await mounted((sql) => {
        if (sql.includes('FORMAT=JSON')) throw new Error('unsupported');
        if (sql.startsWith('EXPLAIN')) return [{ id: 1, table: 'users', type: 'ALL' }];
        return [];
      });
      await view.handleMessage({ type: 'aiExplain', index: 0 });
      const user = h.bridge.requestChat.mock.calls[0][0].messages.at(-1).content as string;
      expect(user).toContain('Raw EXPLAIN output:');
      expect(user).toContain('"table":"users"');
    });

    it('does nothing when there is no plan yet', async () => {
      h.bridge = { requestChat: vi.fn() };
      const { manager } = makeManager(() => [MYSQL_PLAN]);
      ExplainPanel.open(manager, conn(), 'SELECT 1');
      await (ExplainPanel.find('c1') as any).handleMessage({ type: 'aiExplain', index: 0 });
      expect(h.bridge.requestChat).not.toHaveBeenCalled();
    });

    it('never sends a statement containing a password literal', async () => {
      h.bridge = { requestChat: vi.fn() };
      const view = await mounted(() => [MYSQL_PLAN]);
      view.lastStatements[0].sql = "SELECT * FROM t WHERE p = PASSWORD = 'x'";
      await view.handleMessage({ type: 'aiExplain', index: 0 });
      expect(h.bridge.requestChat).not.toHaveBeenCalled();
      expect(posts(view).at(-1)).toMatchObject({ type: 'error' });
    });
  });

  describe('index suggestions', () => {
    const FILTERED_PLAN = { EXPLAIN: JSON.stringify({ query_block: { select_id: 1, table: { table_name: 'users', access_type: 'ALL', rows_examined_per_scan: 5000, attached_condition: "(`users`.`status` = 'x')" } } }) };

    it('attaches suggestions to the plan payload', async () => {
      const metadata = {
        getColumns: vi.fn(async () => [{ name: 'id', type: 'int', isPrimary: true, isUnique: false }, { name: 'status', type: 'varchar(20)', isPrimary: false, isUnique: false }]),
        getIndexes: vi.fn(async () => []),
        createIndexSql: (name: string, table: string, cols: string[]) => `CREATE INDEX ${name} ON ${table} (${cols.join(', ')})`,
      };
      const { manager } = makeManager(() => [FILTERED_PLAN], metadata);
      ExplainPanel.open(manager, conn(), "SELECT * FROM users WHERE status = 'x'");
      const view: any = ExplainPanel.find('c1');
      await mount(view);
      const stmt = posts(view).find((m) => m.type === 'explainPlan').statements[0];
      expect(stmt.plan).not.toBeNull();
      expect(stmt.suggestions).toEqual([
        expect.objectContaining({ table: 'users', columns: ['status'], sql: 'CREATE INDEX idx_users_status ON users (status)' }),
      ]);
      expect(metadata.getColumns).toHaveBeenCalledWith('users', 'app', undefined);
    });

    it('still shows the plan when metadata reads fail', async () => {
      const metadata = {
        getColumns: vi.fn(async () => { throw new Error('denied'); }),
        getIndexes: vi.fn(async () => []),
        createIndexSql: vi.fn(),
      };
      const { manager } = makeManager(() => [FILTERED_PLAN], metadata);
      ExplainPanel.open(manager, conn(), "SELECT * FROM users WHERE status = 'x'");
      const view: any = ExplainPanel.find('c1');
      await mount(view);
      const stmt = posts(view).find((m) => m.type === 'explainPlan').statements[0];
      expect(stmt.plan.roots[0].children[0].object).toBe('users');
      expect(stmt.suggestions).toEqual([]);
    });

    it('does not read metadata when the plan has no flagged table', async () => {
      const metadata = { getColumns: vi.fn(), getIndexes: vi.fn(), createIndexSql: vi.fn() };
      const SMALL = { EXPLAIN: JSON.stringify({ query_block: { select_id: 1, table: { table_name: 'users', access_type: 'ref', key: 'k', rows_examined_per_scan: 1 } } }) };
      const { manager } = makeManager(() => [SMALL], metadata);
      ExplainPanel.open(manager, conn(), 'SELECT * FROM users WHERE id = 1');
      await mount(ExplainPanel.find('c1'));
      expect(metadata.getColumns).not.toHaveBeenCalled();
    });
  });

  describe('per-statement errors (L1)', () => {
    it('shows the other statements when one statement fails', async () => {
      const { manager } = makeManager((sql) => {
        if (sql.startsWith('EXPLAIN') && sql.includes('nope')) throw new Error("Table 'app.nope' doesn't exist");
        return [MYSQL_PLAN];
      });
      ExplainPanel.open(manager, conn(), 'SELECT * FROM users; SELECT * FROM nope');
      const view: any = ExplainPanel.find('c1');
      await mount(view);
      const plan = posts(view).find((m) => m.type === 'explainPlan');
      expect(plan.statements).toHaveLength(2);
      expect(plan.statements[0].plan).not.toBeNull();
      expect(plan.statements[1]).toMatchObject({ sql: 'SELECT * FROM nope', plan: null, error: "Table 'app.nope' doesn't exist" });
    });

    it('reports a single error when every statement fails', async () => {
      const { manager } = makeManager((sql) => {
        if (sql.startsWith('EXPLAIN')) throw new Error('syntax error');
        return [];
      });
      ExplainPanel.open(manager, conn(), 'SELECT 1; SELECT 2');
      const view: any = ExplainPanel.find('c1');
      await mount(view);
      expect(posts(view).some((m) => m.type === 'explainPlan')).toBe(false);
      expect(posts(view).at(-1)).toEqual({ type: 'error', message: 'syntax error' });
    });
  });

  describe('PostgreSQL schema (M3)', () => {
    const PG_PLAN = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 10 } }];

    it('runs on an isolated session with search_path set to the schema, then closes it', async () => {
      const { manager, executed } = makeManager(() => PG_PLAN);
      ExplainPanel.open(manager, conn({ dbType: 'PG', database: 'shop' }), 'SELECT * FROM orders', 'shop', 'sales');
      const view: any = ExplainPanel.find('c1');
      await mount(view);

      expect(manager.openIsolatedSql).toHaveBeenCalledTimes(1);
      expect(manager.connectSql).not.toHaveBeenCalled();
      expect(executed[0]).toBe('SET search_path TO "sales", public');
      expect(executed).toContain('EXPLAIN (FORMAT JSON) SELECT * FROM orders');
      expect(executed.some((sql) => /\b(BEGIN|ROLLBACK|SET LOCAL)\b/i.test(sql))).toBe(false);
      expect(manager.isolatedClose).toHaveBeenCalledTimes(1);
      expect(posts(view).find((m) => m.type === 'explainPlan').statements[0].plan.roots[0].object).toBe('orders');
    });

    it('closes the isolated session when EXPLAIN fails', async () => {
      const { manager } = makeManager((sql) => {
        if (sql.startsWith('EXPLAIN')) throw new Error('relation "orders" does not exist');
        return [];
      });
      ExplainPanel.open(manager, conn({ dbType: 'PG' }), 'SELECT * FROM orders', 'shop', 'sales');
      await mount(ExplainPanel.find('c1'));
      expect(manager.isolatedClose).toHaveBeenCalledTimes(1);
    });

    it('closes the isolated session when setting search_path fails', async () => {
      const { manager } = makeManager((sql) => {
        if (sql.startsWith('SET search_path')) throw new Error('permission denied');
        return PG_PLAN;
      });
      ExplainPanel.open(manager, conn({ dbType: 'PG' }), 'SELECT 1', 'shop', 'sales');
      const view: any = ExplainPanel.find('c1');
      await mount(view);
      expect(manager.isolatedClose).toHaveBeenCalledTimes(1);
      expect(posts(view).at(-1)).toEqual({ type: 'error', message: 'permission denied' });
    });

    it('uses the shared session when no schema is given', async () => {
      const { manager } = makeManager(() => PG_PLAN);
      ExplainPanel.open(manager, conn({ dbType: 'PG' }), 'SELECT * FROM orders', 'shop');
      await mount(ExplainPanel.find('c1'));
      expect(manager.openIsolatedSql).not.toHaveBeenCalled();
      expect(manager.connectSql).toHaveBeenCalledTimes(1);
    });
  });
});
