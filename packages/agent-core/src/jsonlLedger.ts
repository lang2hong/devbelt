import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  LedgerError,
  TERMINAL_STATES,
  canTransition,
  reduceLedger,
  validateLedgerEvent,
} from './ledger.js';
import type { ExecutionLedger, LedgerEvent, LedgerEventInput, ProposalLedgerState } from './ledger.js';

export interface JsonlLedgerOptions {
  /** Absolute path of the ledger file. The lock file is `<path>.lock`. */
  path: string;
  /** Clock injection for tests. */
  now?: () => number;
  /** A lock older than this is treated as stale and removed. Default 60 s. */
  staleLockMs?: number;
}

export interface LoadReport {
  events: LedgerEvent[];
  /** True when an incomplete final line was dropped. */
  truncatedTail: boolean;
}

/**
 * Append-only JSONL execution ledger.
 *
 * - Each event is one line, written with `appendFile` and `fsync`.
 * - Writers are serialised by an exclusive `<path>.lock` file; if the lock
 *   is held the append fails closed and the caller must block W2/W3.
 * - Readers do not take the lock.
 * - An incomplete final line (crash during write) is ignored on read and
 *   removed before the next append; corruption anywhere else is fatal.
 */
export class JsonlExecutionLedger implements ExecutionLedger {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly staleLockMs: number;

  constructor(options: JsonlLedgerOptions) {
    if (!options.path) throw new LedgerError('io', 'ledger path is required');
    this.path = options.path;
    this.lockPath = `${options.path}.lock`;
    this.now = options.now ?? Date.now;
    this.staleLockMs = options.staleLockMs ?? 60_000;
  }

  async load(): Promise<LedgerEvent[]> {
    return (await this.read()).events;
  }

  /** Like `load`, but also reports whether a partial tail line was dropped. */
  async read(): Promise<LoadReport> {
    let text: string;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncatedTail: false };
      throw new LedgerError('io', 'cannot read ledger', { cause: err });
    }
    return parse(text);
  }

  async state(): Promise<Map<string, ProposalLedgerState>> {
    return reduceLedger(await this.load());
  }

  async append(input: LedgerEventInput): Promise<LedgerEvent> {
    return this.withLock(async () => {
      const [event] = await this.appendLocked([input]);
      return event!;
    });
  }

  async recoverInterrupted(): Promise<LedgerEvent[]> {
    return this.withLock(async () => {
      const states = reduceLedger((await this.readForWrite()).events);
      const inputs: LedgerEventInput[] = [];
      for (const s of states.values()) {
        if (s.state !== 'EXECUTING') continue;
        const { v: _v, seq: _seq, at: _at, ...base } = s.last;
        inputs.push({ ...base, state: 'UNKNOWN', errorCode: 'interrupted' });
      }
      return inputs.length > 0 ? this.appendLocked(inputs) : [];
    });
  }

  /** Copy of the raw ledger for export; validated before it is returned. */
  async exportText(): Promise<string> {
    const { events } = await this.read();
    return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  }

  private async appendLocked(inputs: readonly LedgerEventInput[]): Promise<LedgerEvent[]> {
    const { events } = await this.readForWrite();
    const states = reduceLedger(events);
    let seq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    const written: LedgerEvent[] = [];
    for (const input of inputs) {
      const current = states.get(input.proposalId);
      if (current && TERMINAL_STATES.includes(current.state)) {
        throw new LedgerError('invalid_transition', `${input.proposalId} is already ${current.state}`);
      }
      if (!canTransition(current?.state, input.state)) {
        throw new LedgerError('invalid_transition', `${input.proposalId}: ${current?.state ?? 'NONE'} -> ${input.state}`);
      }
      const event = validateLedgerEvent({ ...input, v: 1, seq: ++seq, at: this.now() });
      // Re-run the reducer to enforce binding immutability across events.
      reduceLedger([...events, ...written, event]);
      written.push(event);
      states.set(event.proposalId, current
        ? { ...current, state: event.state, last: event }
        : { proposalId: event.proposalId, state: event.state, first: event, last: event });
    }
    await this.writeDurable(written.map((e) => JSON.stringify(e) + '\n').join(''));
    return written;
  }

  /** Read for writing: drop a partial tail so the next append starts on a fresh line. */
  private async readForWrite(): Promise<LoadReport> {
    const report = await this.read();
    if (report.truncatedTail) {
      const text = report.events.map((e) => JSON.stringify(e) + '\n').join('');
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(tmp, text, { mode: 0o600 });
        const handle = await fs.open(tmp, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(tmp, this.path);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw new LedgerError('io', 'cannot repair ledger tail', { cause: err });
      }
    }
    return report;
  }

  private async writeDurable(text: string): Promise<void> {
    if (!text) return;
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      const handle = await fs.open(this.path, 'a', 0o600);
      try {
        await handle.appendFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw new LedgerError('io', 'cannot persist ledger event', { cause: err });
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
    } catch (err) {
      throw new LedgerError('io', 'cannot create ledger directory', { cause: err });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now() }), 'utf8');
        } finally {
          await handle.close();
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new LedgerError('io', 'cannot acquire ledger lock', { cause: err });
        }
        if (attempt === 0 && (await this.isStaleLock())) {
          await fs.rm(this.lockPath, { force: true }).catch(() => {});
          continue;
        }
        throw new LedgerError('locked', 'ledger is locked by another writer');
      }
    }
    throw new LedgerError('locked', 'ledger is locked by another writer');
  }

  private async isStaleLock(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.lockPath);
      return this.now() - stat.mtimeMs > this.staleLockMs;
    } catch {
      return false;
    }
  }
}

function parse(text: string): LoadReport {
  if (!text) return { events: [], truncatedTail: false };
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  const events: LedgerEvent[] = [];
  let truncatedTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    if (!line) {
      if (isLast && !endsWithNewline) { truncatedTail = true; continue; }
      throw new LedgerError('corrupt', `empty line at ${i + 1}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Only an unterminated final line can be a crash artefact.
      if (isLast && !endsWithNewline) { truncatedTail = true; continue; }
      throw new LedgerError('corrupt', `invalid JSON at line ${i + 1}`, { cause: err });
    }
    if (isLast && !endsWithNewline) {
      // A complete JSON value without its newline is still an interrupted write.
      truncatedTail = true;
      continue;
    }
    try {
      events.push(validateLedgerEvent(parsed));
    } catch (err) {
      throw new LedgerError('corrupt', `invalid event at line ${i + 1}: ${(err as Error).message}`, { cause: err });
    }
  }
  // Validate ordering and transitions of what remains.
  reduceLedger(events);
  return { events, truncatedTail };
}
