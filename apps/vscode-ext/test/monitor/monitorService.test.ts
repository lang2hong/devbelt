import { describe, expect, it, vi } from 'vitest';
import type { ColumnMeta } from '@devbelt/db-core';
import { MonitorService, sanitizeCondition, type MonitorServiceDeps } from '../../src/monitor/monitorService';
import { buildMonitorTool, MONITOR_TOOL_DEFINITION, toProposalInput } from '../../src/agent/monitorTool';
import { guardToolCall, defineToolRegistry } from '@devbelt/agent-core';
import type { MonitorTask } from '../../src/monitor/monitorTypes';

const conn = { id: 'c1', name: 'local', host: 'h', port: 3306, user: 'u', dbType: 'MYSQL', database: 'app' } as never;

function col(name: string, type: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name, type, simpleType: type, comment: '', key: '', nullable: 'NO', maxLength: '', defaultValue: null,
    extra: '', isNotNull: true, isAutoIncrement: false, isUnique: false, isPrimary: false, pk: '', ...over,
  };
}

function setup(over: Partial<MonitorServiceDeps> = {}, trialRows: unknown[] = [{ lag_seconds: '30', rows_last_1h: '5' }]) {
  const tasks: MonitorTask[] = [];
  const queries: string[] = [];
  const trial = vi.fn(async (_target: unknown, fn: (session: never, token: never, dbType: string) => Promise<unknown>) => fn({
    query: {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT MAX')) return { rows: [{ v: '100' }] };
        if (sql.includes('>=')) return { rows: [{ id: '100' }] };
        return { rows: trialRows };
      },
      wrap: (s: string) => `\`${s}\``,
    },
  } as never, {} as never, 'MYSQL'));
  const scheduler = {
    list: () => tasks,
    get: (id: string) => tasks.find((t) => t.id === id),
    add: vi.fn(async (task: MonitorTask) => { tasks.push(task); }),
  };
  const deps: MonitorServiceDeps = {
    scheduler: scheduler as never,
    executor: { trial } as never,
    getConnection: () => conn,
    fingerprint: () => 'fp',
    allowProduction: () => false,
    maxTasks: () => 20,
    enabled: () => true,
    describe: async () => ({ columns: [col('id', 'bigint', { isPrimary: true }), col('name', 'varchar(20)')], indexes: [] }),
    audit: vi.fn(),
    ...over,
  };
  return { service: new MonitorService(deps), scheduler, tasks, queries, deps, trial };
}

describe('MonitorService proposals', () => {
  it('validates a metric by trial run and does not create a task', async () => {
    const { service, scheduler, queries } = setup();
    const r = await service.propose(conn, 'app', undefined, { kind: 'metric', table: 'lc_data_event', sql: 'SELECT 30 AS lag_seconds, 5 AS rows_last_1h;', watchColumn: 'lag_seconds', intervalMinutes: 5, condition: { type: 'above', value: 600 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal).toMatchObject({ sql: 'SELECT 30 AS lag_seconds, 5 AS rows_last_1h', watchColumn: 'lag_seconds', preview: { lag_seconds: 30, rows_last_1h: 5 }, intervalMs: 300_000 });
    expect(scheduler.add).not.toHaveBeenCalled();
    expect(queries).toEqual(['SELECT 30 AS lag_seconds, 5 AS rows_last_1h']);
  });

  it('rejects writes before touching the database and reports trial failures', async () => {
    const { service, trial } = setup();
    const write = await service.propose(conn, 'app', undefined, { kind: 'metric', table: 't', sql: 'UPDATE t SET a = 1' });
    expect(write).toMatchObject({ ok: false, reason: 'validation' });
    expect(trial).not.toHaveBeenCalled();
    const bad = setup({}, [{ a: 'x' }]);
    expect(await bad.service.propose(conn, 'app', undefined, { kind: 'metric', table: 't', sql: 'SELECT a FROM t' })).toMatchObject({ ok: false, issues: [{ code: 'nonNumeric' }] });
  });

  it('rejects an invented cursor column instead of guessing', async () => {
    const { service } = setup();
    const r = await service.propose(conn, 'app', undefined, { kind: 'newRows', table: 'oms_order', cursorColumn: 'create_time' });
    expect(r).toMatchObject({ ok: false, reason: 'validation', issues: [{ code: 'columnMissing', detail: 'create_time' }] });
    const typed = await service.propose(conn, 'app', undefined, { kind: 'newRows', table: 'oms_order', cursorColumn: 'name' });
    expect(typed).toMatchObject({ ok: false, issues: [{ code: 'cursorType' }] });
  });

  it('honours production, duplicate and enabled rules', async () => {
    const prod = setup();
    expect(await prod.service.propose({ ...(conn as object), environment: 'production' } as never, 'app', undefined, { kind: 'rowCount', table: 't' }))
      .toMatchObject({ ok: false, reason: 'production' });
    const off = setup({ enabled: () => false });
    expect(await off.service.propose(conn, 'app', undefined, { kind: 'rowCount', table: 't' })).toMatchObject({ ok: false, reason: 'disabled' });
  });

  it('creates only on confirm, re-validates, takes the cursor baseline and marks the origin', async () => {
    const { service, tasks, deps } = setup();
    const r = await service.propose(conn, 'app', undefined, { kind: 'newRows', table: 'events', cursorColumn: 'ID', intervalMinutes: 15 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.cursorColumn).toBe('id');
    expect(r.proposal.condition).toBeUndefined(); // 用户没说条件：不替用户猜
    expect(tasks).toHaveLength(0);
    // 没选条件时不能创建
    expect(await service.confirm(r.proposal.id)).toMatchObject({ ok: false, reason: 'conditionMissing' });
    const confirmed = await service.confirm(r.proposal.id, { intervalMinutes: 30, condition: { type: 'increaseBy', value: 5 } });
    expect(confirmed.ok).toBe(true);
    expect(tasks[0]).toMatchObject({ kind: 'newRows', cursorColumn: 'id', primaryKey: ['id'], cursorValue: '100', cursorSeen: [JSON.stringify(['100'])], intervalMs: 1_800_000, origin: 'ai', connFingerprint: 'fp', condition: { type: 'increaseBy', value: 5 } });
    expect(deps.audit).toHaveBeenCalledWith('create', expect.objectContaining({ kind: 'newRows' }));
    expect(await service.confirm(r.proposal.id)).toMatchObject({ ok: false, reason: 'unknownProposal' });
  });

  it('refuses unknown or forged proposal ids', async () => {
    const { service } = setup();
    expect(await service.confirm('../x')).toMatchObject({ ok: false, reason: 'unknownProposal' });
    expect(await service.confirm('p123')).toMatchObject({ ok: false, reason: 'unknownProposal' });
  });

  it('fails confirmation when the table changed since the proposal', async () => {
    let columns = [col('id', 'bigint', { isPrimary: true })];
    const { service, tasks } = setup({ describe: async () => ({ columns, indexes: [] }) });
    const r = await service.propose(conn, 'app', undefined, { kind: 'newRows', table: 'events', cursorColumn: 'id', condition: { type: 'increaseBy', value: 1 } });
    if (!r.ok) throw new Error('expected a proposal');
    columns = [];
    expect(await service.confirm(r.proposal.id)).toMatchObject({ ok: false, reason: 'validation', issues: [{ code: 'tableMissing' }] });
    expect(tasks).toHaveLength(0);
  });

  it('a window that does not own the tasks neither trial-runs nor creates', async () => {
    let owner = true;
    const { service, trial, tasks } = setup({ isOwner: () => owner });
    const r = await service.propose(conn, 'app', undefined, { kind: 'metric', table: 't', sql: 'SELECT 1 AS lag_seconds, 2 AS rows_last_1h', condition: { type: 'above', value: 5 } });
    if (!r.ok) throw new Error('expected a proposal');
    trial.mockClear();
    owner = false;
    expect(await service.propose(conn, 'app', undefined, { kind: 'metric', table: 't', sql: 'SELECT 1 AS a' })).toMatchObject({ ok: false, reason: 'otherWindow' });
    expect(await service.confirm(r.proposal.id)).toMatchObject({ ok: false, reason: 'otherWindow' });
    expect(trial).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it('does not count session setup as query time', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { service } = setup({
      executor: { trial: async (_t: unknown, fn: (s: never, tk: never, d: string) => Promise<unknown>) => {
        now += 20_000; // 慢的 SSH 隧道 / 建会话
        return fn({ query: { query: async () => { now += 100; return { rows: [{ lag_seconds: '1' }] }; }, wrap: (s: string) => s } } as never, {} as never, 'MYSQL');
      } } as never,
    });
    const r = await service.propose(conn, 'app', undefined, { kind: 'metric', table: 't', sql: 'SELECT 1 AS lag_seconds' });
    spy.mockRestore();
    if (!r.ok) throw new Error('expected a proposal');
    expect(r.proposal.warnings).toEqual([]);
  });

  it('flags a slow metric trial without changing the interval', async () => {
    let now = 0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { service } = setup({
      executor: { trial: async (_t: unknown, fn: (s: never, tk: never, d: string) => Promise<unknown>) => fn({ query: { query: async () => { now += 6_000; return { rows: [{ lag_seconds: '1' }] }; }, wrap: (s: string) => s } } as never, {} as never, 'MYSQL') } as never,
    });
    const r = await service.propose(conn, 'app', undefined, { kind: 'metric', table: 't', sql: 'SELECT 1 AS lag_seconds', intervalMinutes: 5 });
    spy.mockRestore();
    if (!r.ok) throw new Error('expected a proposal');
    expect(r.proposal.warnings).toEqual([{ level: 'warning', code: 'slowQuery', detail: '6' }]);
    expect(r.proposal.intervalMs).toBe(300_000);
  });

  it('validates model-supplied conditions instead of silently replacing them', () => {
    expect(sanitizeCondition({ type: 'above', value: 600 }, 'metric')).toEqual({ ok: true, condition: { type: 'above', value: 600 } });
    expect(sanitizeCondition(undefined, 'metric')).toEqual({ ok: true });
    // 非法：不再换成默认值，交给调用方拒绝
    expect(sanitizeCondition({ type: 'drop_table', value: 1 }, 'metric')).toEqual({ ok: false });
    expect(sanitizeCondition({ type: 'decreaseBy', value: 3 }, 'newRows')).toEqual({ ok: false });
    expect(sanitizeCondition({ type: 'increaseBy', value: -1 }, 'rowCount')).toEqual({ ok: false });
    expect(sanitizeCondition({ type: 'above' }, 'metric')).toEqual({ ok: false });
  });

  it('rejects an invalid condition and reports a missing one', async () => {
    const { service, tasks } = setup();
    expect(await service.propose(conn, 'app', undefined, { kind: 'rowCount', table: 't', condition: { type: 'drop_table', value: 1 } as never })).toMatchObject({ ok: false, reason: 'conditionInvalid' });
    const r = await service.propose(conn, 'app', undefined, { kind: 'rowCount', table: 't' });
    if (!r.ok) throw new Error('expected a proposal');
    expect(await service.confirm(r.proposal.id, { condition: { type: 'increaseBy', value: 0 } })).toMatchObject({ ok: false, reason: 'conditionInvalid' });
    expect(tasks).toHaveLength(0);
  });

  it('edits the interval and condition of a created task', async () => {
    const { service, scheduler, tasks, deps } = setup();
    const r = await service.propose(conn, 'app', undefined, { kind: 'rowCount', table: 't', condition: { type: 'anyChange' } });
    if (!r.ok) throw new Error('expected a proposal');
    const created = await service.confirm(r.proposal.id, { intervalMinutes: 5 });
    if (!created.ok) throw new Error('confirm failed');
    (scheduler as unknown as { edit: (id: string, patch: Record<string, unknown>) => Promise<void> }).edit = vi.fn(
      async (id: string, patch: Record<string, unknown>) => {
        const task = tasks.find((t) => t.id === id)!;
        Object.assign(task, patch);
      },
    );
    expect(await service.edit(created.task.id, { intervalMinutes: 30, condition: { type: 'below', value: 3 } }))
      .toMatchObject({ ok: true, task: { intervalMs: 1_800_000, condition: { type: 'below', value: 3 } } });
    expect(deps.audit).toHaveBeenCalledWith('edit', expect.objectContaining({ id: created.task.id }));
    expect(await service.edit('nope', { intervalMinutes: 5 })).toMatchObject({ ok: false, reason: 'unknownTask' });
    expect(await service.edit(created.task.id, { condition: { type: 'nope' } as never })).toMatchObject({ ok: false, reason: 'conditionInvalid' });
  });
});

describe('propose_monitor tool', () => {
  it('is a read-class tool that is never exposed to MCP and takes no connection arguments', () => {
    expect(MONITOR_TOOL_DEFINITION).toMatchObject({ riskClass: 'R1', mcp: false });
    const props = Object.keys((MONITOR_TOOL_DEFINITION.parameters as { properties: object }).properties);
    for (const forbidden of ['connection', 'connectionId', 'database', 'schema', 'host']) expect(props).not.toContain(forbidden);
    const registry = defineToolRegistry([MONITOR_TOOL_DEFINITION]);
    const guarded = guardToolCall(registry, {
      surface: 'agent', toolName: 'propose_monitor', args: { kind: 'rowCount', table: 't', database: 'other' }, connectionId: 'c1',
      connection: { dialect: 'MYSQL', production: false, readOnly: false },
      settings: { agentEnabled: true, allowWrites: false, allowDdl: false, allowProduction: false, mcpEnabled: false, mcpAllowedConnections: [] },
    });
    expect(guarded.allowed).toBe(false);
  });

  it('returns a proposal for confirmation and never says the task is running', async () => {
    const { service, tasks } = setup();
    const proposals: unknown[] = [];
    const tool = buildMonitorTool({ service, conn, database: 'app', onProposal: (p) => proposals.push(p) });
    const out = await tool.execute({ id: '1', type: 'function', function: { name: 'propose_monitor', arguments: '' } }, { kind: 'rowCount', table: 'oms_order', intervalMinutes: 5 });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ created: false, status: 'awaiting_user_confirmation' });
    expect(proposals).toHaveLength(1);
    expect(tasks).toHaveLength(0);
  });

  it('reports rejections back to the model', async () => {
    const { service } = setup();
    const tool = buildMonitorTool({ service, conn, database: 'app', onProposal: () => undefined });
    const out = await tool.execute({ id: '1', type: 'function', function: { name: 'propose_monitor', arguments: '' } }, { kind: 'newRows', table: 'oms_order', cursorColumn: 'create_time' });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ created: false, rejected: 'validation' });
  });

  it('maps tool arguments to proposal input', () => {
    expect(toProposalInput({ kind: 'metric', table: 't', sql: 'SELECT 1 AS a', conditionType: 'above', conditionValue: 10, intervalMinutes: 5 }))
      .toEqual({ kind: 'metric', table: 't', sql: 'SELECT 1 AS a', condition: { type: 'above', value: 10 }, intervalMinutes: 5 });
  });
});
