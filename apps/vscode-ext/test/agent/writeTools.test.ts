import { describe, expect, it, vi } from 'vitest';
import { DatabaseType } from '@devbelt/db-core';
import type { ExecutionLedger, LedgerEventInput, LedgerEvent } from '@devbelt/agent-core';
import { buildWriteTools, type WriteToolDeps } from '../../src/agent/writeTools.js';

function ledger(events: LedgerEventInput[], failOn?: string): ExecutionLedger & { events: LedgerEventInput[] } {
  return {
    events,
    async append(event) {
      if (failOn && event.state === failOn) throw new Error('ledger down');
      events.push(event);
      return { ...event, v: 1, seq: events.length, at: 1 } as LedgerEvent;
    },
    async load() { return []; },
    async recoverInterrupted() { return []; },
  };
}

function session(opts: { affectedRows?: number; failOn?: string } = {}) {
  const sql: string[] = [];
  return {
    sql,
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes('information_schema.triggers')) return { rows: [{ n: 0 }] } as never;
      if (opts.failOn && statement.includes(opts.failOn)) throw new Error('boom');
      return { affectedRows: opts.affectedRows ?? 3 } as never;
    },
  };
}

function deps(over: Partial<WriteToolDeps> = {}, s = session({ affectedRows: 3 })) {
  const events: LedgerEventInput[] = [];
  const body: WriteToolDeps = {
    dbType: DatabaseType.PG,
    target: { connectionId: 'c1', database: 'app', schema: 'public', dialect: 'PG' },
    connection: { readOnly: false, production: false },
    settings: { allowWrites: true, allowDdl: true, allowProduction: false },
    openSession: async () => ({ session: s as never, close: () => undefined }),
    confirm: async () => true,
    ledger: ledger(events),
    now: () => 1_000_000,
    ttlMs: 60_000,
    ...over,
  };
  return { body, events, session: s };
}

const signal = new AbortController().signal;

describe('write tools', () => {
  it('refuses when writes are disabled, the connection is read-only, or it is production', async () => {
    for (const [over, code] of [
      [{ settings: { allowWrites: false, allowDdl: true, allowProduction: false } }, 'writes_disabled'],
      [{ connection: { readOnly: true, production: false } }, 'read_only_connection'],
      [{ connection: { readOnly: false, production: true } }, 'production_denied'],
    ] as const) {
      const { body, events } = deps(over);
      const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', signal);
      expect(out).toMatchObject({ isError: true, errorCode: code });
      expect(events).toEqual([]);
    }
  });

  it('rejects cross-kind statements', async () => {
    const { body, events } = deps();
    const tools = buildWriteTools(body);
    expect(await tools.execute('propose_write', 'ALTER TABLE t ADD c int', signal)).toMatchObject({ errorCode: 'wrong_kind' });
    expect(await tools.execute('propose_ddl', 'UPDATE t SET a = 1', signal)).toMatchObject({ errorCode: 'wrong_kind' });
    expect(events).toEqual([]);
  });

  it('records PROPOSED then REJECTED and never executes when the user declines', async () => {
    const { body, events, session: s } = deps({ confirm: async () => false });
    const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', signal);
    expect(out).toMatchObject({ isError: true, errorCode: 'rejected' });
    expect(events.map((e) => e.state)).toEqual(['PROPOSED', 'REJECTED']);
    expect(s.sql.filter((q) => q === 'UPDATE t SET a = 1')).toHaveLength(1); // dry run only
    expect(s.sql).toContain('ROLLBACK');
  });

  it('executes once after approval and records the full event sequence', async () => {
    const { body, events } = deps();
    const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', signal);
    expect(out).toMatchObject({ summary: '已执行，影响 3 行' });
    expect(events.map((e) => e.state)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED']);
    expect(events[3]).toMatchObject({ affectedRows: 3 });
  });

  it('does not ask for approval or execute when the PROPOSED record cannot be written', async () => {
    const confirm = vi.fn(async () => true);
    const events: LedgerEventInput[] = [];
    const { body } = deps({ confirm, ledger: ledger(events, 'PROPOSED') });
    const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', signal);
    expect(out).toMatchObject({ isError: true, errorCode: 'ledger_failed' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not execute when EXECUTING cannot be recorded', async () => {
    const events: LedgerEventInput[] = [];
    const s = session({ affectedRows: 3 });
    const { body } = deps({ ledger: ledger(events, 'EXECUTING') }, s);
    const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', signal);
    expect(out).toMatchObject({ errorCode: 'ledger_failed' });
    expect(s.sql.filter((q) => q === 'UPDATE t SET a = 1')).toHaveLength(1); // dry run only
  });

  it('records FAILED and returns the error when execution fails', async () => {
    const s = session({ failOn: 'UPDATE' });
    // Dry run is skipped so execution is the first UPDATE.
    const { body, events } = deps({}, s);
    const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', signal);
    expect(out).toMatchObject({ isError: true, errorCode: 'execution_failed' });
    expect(events.map((e) => e.state)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'FAILED']);
  });

  it('never dry-runs DDL but still requires approval and executes it', async () => {
    const s = session({ affectedRows: 0 });
    const { body, events } = deps({}, s);
    const out = await buildWriteTools(body).execute('propose_ddl', 'CREATE TABLE t (a int)', signal);
    expect(out.summary).toBe('已执行，影响 0 行');
    expect(s.sql).toEqual(['CREATE TABLE t (a int)']);
    expect(events.map((e) => e.state)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED']);
  });

  it('records UNKNOWN and does not execute when aborted after approval', async () => {
    const controller = new AbortController();
    const { body, events } = deps({ confirm: async () => { controller.abort(); return true; } });
    const out = await buildWriteTools(body).execute('propose_write', 'UPDATE t SET a = 1', controller.signal);
    expect(out).toMatchObject({ isError: true, errorCode: 'aborted' });
    expect(events.map((e) => e.state)).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'UNKNOWN']);
  });

  it('refuses DDL when allowDdl is off', async () => {
    const { body } = deps({ settings: { allowWrites: true, allowDdl: false, allowProduction: false } });
    expect(await buildWriteTools(body).execute('propose_ddl', 'CREATE TABLE t (a int)', signal))
      .toMatchObject({ errorCode: 'ddl_disabled' });
  });
});