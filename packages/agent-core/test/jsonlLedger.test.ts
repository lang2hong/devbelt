import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlExecutionLedger, LedgerError, computeSqlHash, reduceLedger, validateLedgerEvent } from '../src/index.js';
import type { LedgerEventInput, LedgerState, TargetBinding } from '../src/index.js';

const target: TargetBinding = { connectionId: 'c1', database: 'shop', schema: 'sales', dialect: 'PG' };
const sqlHash = computeSqlHash(target, 'UPDATE "sales"."orders" SET status = 1');

const ev = (proposalId: string, state: LedgerState, over: Partial<LedgerEventInput> = {}): LedgerEventInput => ({
  proposalId,
  state,
  surface: 'agent',
  riskClass: 'W2',
  target,
  sqlHash,
  ...over,
});

let dir: string;
let file: string;
let clock: number;
const ledger = (staleLockMs?: number) => new JsonlExecutionLedger({
  path: file,
  now: () => clock,
  ...(staleLockMs !== undefined ? { staleLockMs } : {}),
});

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'agent-ledger-'));
  file = join(dir, 'nested', 'ledger.jsonl');
  clock = 1_000;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function walk(l: JsonlExecutionLedger, id: string, states: LedgerState[]): Promise<void> {
  for (const s of states) {
    clock += 1;
    await l.append(ev(id, s));
  }
}

describe('JsonlExecutionLedger', () => {
  it('returns an empty ledger when the file does not exist', async () => {
    expect(await ledger().load()).toEqual([]);
  });

  it('appends one JSON line per event with increasing seq and replays state', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED', 'APPROVED', 'EXECUTING']);
    clock += 1;
    await l.append(ev('p1', 'SUCCEEDED', { affectedRows: 3, durationMs: 12 }));

    const text = await fs.readFile(file, 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual([1, 2, 3, 4]);

    const state = (await l.state()).get('p1');
    expect(state?.state).toBe('SUCCEEDED');
    expect(state?.last.affectedRows).toBe(3);
  });

  it('creates the file with owner-only permissions', async () => {
    await ledger().append(ev('p1', 'PROPOSED'));
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects invalid transitions and writes after a terminal state', async () => {
    const l = ledger();
    await expect(l.append(ev('p1', 'EXECUTING'))).rejects.toMatchObject({ code: 'invalid_transition' });
    await walk(l, 'p1', ['PROPOSED', 'REJECTED']);
    await expect(l.append(ev('p1', 'APPROVED'))).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await l.load()).toHaveLength(2);
  });

  it('rejects a binding change for an existing proposal', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED']);
    const other = computeSqlHash(target, 'DELETE FROM "sales"."orders"');
    await expect(l.append(ev('p1', 'APPROVED', { sqlHash: other }))).rejects.toMatchObject({ code: 'invalid_event' });
    await expect(l.append(ev('p1', 'APPROVED', { target: { ...target, schema: 'public' } }))).rejects.toMatchObject({ code: 'invalid_event' });
    expect(await l.load()).toHaveLength(1);
  });

  it('rejects unknown fields so SQL text or nonces cannot be persisted', async () => {
    const l = ledger();
    await expect(l.append({ ...ev('p1', 'PROPOSED'), sql: 'SELECT 1' } as never)).rejects.toMatchObject({ code: 'invalid_event' });
    await expect(l.append({ ...ev('p1', 'PROPOSED'), approvalNonce: 'secret' } as never)).rejects.toMatchObject({ code: 'invalid_event' });
    await expect(l.append(ev('p1', 'PROPOSED', { target: { ...target, password: 'x' } as never }))).rejects.toMatchObject({ code: 'invalid_event' });
    await expect(l.append(ev('p1', 'PROPOSED', { sqlHash: 'not-a-hash' }))).rejects.toMatchObject({ code: 'invalid_event' });
  });

  it('fails closed while another writer holds the lock', async () => {
    const l = ledger();
    await fs.mkdir(join(dir, 'nested'), { recursive: true });
    await fs.writeFile(`${file}.lock`, '{}');
    await expect(l.append(ev('p1', 'PROPOSED'))).rejects.toMatchObject({ code: 'locked' });
    // Reads do not need the lock.
    expect(await l.load()).toEqual([]);
  });

  it('removes a stale lock and continues', async () => {
    await fs.mkdir(join(dir, 'nested'), { recursive: true });
    await fs.writeFile(`${file}.lock`, '{}');
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(`${file}.lock`, old, old);
    clock = Date.now();
    const l = ledger(60_000);
    await l.append(ev('p1', 'PROPOSED'));
    expect(await l.load()).toHaveLength(1);
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the lock after a failed append', async () => {
    const l = ledger();
    await expect(l.append(ev('p1', 'EXECUTING'))).rejects.toBeInstanceOf(LedgerError);
    await expect(fs.stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    await l.append(ev('p1', 'PROPOSED'));
  });

  it('serialises concurrent writers: one succeeds, the other is told the ledger is locked', async () => {
    const a = ledger();
    const b = ledger();
    const results = await Promise.allSettled([a.append(ev('p1', 'PROPOSED')), b.append(ev('p2', 'PROPOSED'))]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const locked = results.filter((r) => r.status === 'rejected' && (r.reason as LedgerError).code === 'locked');
    expect(ok.length + locked.length).toBe(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const events = await a.load();
    expect(events).toHaveLength(ok.length);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it('ignores a partial tail line on read and repairs it before the next append', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED', 'APPROVED']);
    await fs.appendFile(file, '{"v":1,"seq":3,"at":5,"proposalId":"p1","sta');

    const report = await l.read();
    expect(report.truncatedTail).toBe(true);
    expect(report.events).toHaveLength(2);

    clock += 1;
    await l.append(ev('p1', 'EXECUTING'));
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!).state).toBe('EXECUTING');
  });

  it('treats a complete but unterminated final line as an interrupted write', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED']);
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text + JSON.stringify({ ...ev('p1', 'APPROVED'), v: 1, seq: 2, at: 9 }));
    const report = await l.read();
    expect(report.truncatedTail).toBe(true);
    expect(report.events).toHaveLength(1);
  });

  it('refuses to load when a middle line is corrupt', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED']);
    await fs.appendFile(file, 'not json\n');
    await walk(l, 'p2', []);
    await fs.appendFile(file, JSON.stringify({ ...ev('p2', 'PROPOSED'), v: 1, seq: 3, at: 9 }) + '\n');
    await expect(l.load()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(l.append(ev('p3', 'PROPOSED'))).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('refuses to load on non-increasing seq or an invalid transition in the file', async () => {
    await fs.mkdir(join(dir, 'nested'), { recursive: true });
    const line = (seq: number, state: LedgerState) => JSON.stringify({ ...ev('p1', state), v: 1, seq, at: 1 }) + '\n';
    await fs.writeFile(file, line(2, 'PROPOSED') + line(1, 'APPROVED'));
    await expect(ledger().load()).rejects.toMatchObject({ code: 'corrupt' });
    await fs.writeFile(file, line(1, 'PROPOSED') + line(2, 'SUCCEEDED'));
    await expect(ledger().load()).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('recovers interrupted executions as UNKNOWN and is idempotent', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED', 'APPROVED', 'EXECUTING']);
    await walk(l, 'p2', ['PROPOSED', 'APPROVED', 'EXECUTING', 'SUCCEEDED']);
    await walk(l, 'p3', ['PROPOSED']);

    const recovered = await l.recoverInterrupted();
    expect(recovered.map((e) => [e.proposalId, e.state, e.errorCode])).toEqual([['p1', 'UNKNOWN', 'interrupted']]);
    expect(recovered[0]!.sqlHash).toBe(sqlHash);

    const states = await l.state();
    expect(states.get('p1')?.state).toBe('UNKNOWN');
    expect(states.get('p2')?.state).toBe('SUCCEEDED');
    expect(states.get('p3')?.state).toBe('PROPOSED');
    expect(await l.recoverInterrupted()).toEqual([]);
  });

  it('exports only validated events', async () => {
    const l = ledger();
    await walk(l, 'p1', ['PROPOSED', 'APPROVED']);
    await fs.appendFile(file, '{"partial');
    const exported = await l.exportText();
    expect(exported.trimEnd().split('\n')).toHaveLength(2);
    expect(exported.endsWith('\n')).toBe(true);
  });
});

describe('reduceLedger / validateLedgerEvent', () => {
  it('validates required fields', () => {
    expect(() => validateLedgerEvent({ ...ev('p1', 'PROPOSED'), v: 2, seq: 1, at: 1 })).toThrow(/version/);
    expect(() => validateLedgerEvent({ ...ev('p1', 'PROPOSED'), v: 1, seq: 0, at: 1 })).toThrow(/seq/);
    expect(() => validateLedgerEvent({ ...ev('p1', 'PROPOSED'), v: 1, seq: 1, at: 1, affectedRows: -1 })).toThrow(/affectedRows/);
    expect(() => validateLedgerEvent({ ...ev('p1', 'PROPOSED'), v: 1, seq: 1, at: 1, surface: 'web' })).toThrow(/surface/);
  });

  it('allows independent proposals to interleave', () => {
    const mk = (seq: number, id: string, state: LedgerState) => validateLedgerEvent({ ...ev(id, state), v: 1, seq, at: seq });
    const states = reduceLedger([mk(1, 'a', 'PROPOSED'), mk(2, 'b', 'PROPOSED'), mk(3, 'a', 'APPROVED'), mk(4, 'b', 'REVOKED')]);
    expect(states.get('a')?.state).toBe('APPROVED');
    expect(states.get('b')?.state).toBe('REVOKED');
  });
});
