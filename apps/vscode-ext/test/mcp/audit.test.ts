import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpAuditLog } from '../../src/mcp/audit';

const dirs: string[] = [];
async function log(): Promise<{ audit: McpAuditLog; file: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'mcp-audit-'));
  dirs.push(dir);
  const file = join(dir, 'nested', 'audit.jsonl');
  return { audit: new McpAuditLog(file), file };
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('McpAuditLog', () => {
  it('appends one line per call with owner-only permissions', async () => {
    const { audit, file } = await log();
    await audit.append({ at: 1, clientId: 'c', tool: 'list_tables', connectionId: 'db', result: 'ok', durationMs: 5 });
    await audit.append({ at: 2, clientId: 'c', tool: 'run_read_only_query', connectionId: 'db', result: 'error', durationMs: 9, errorCode: 'query_failed' });
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ tool: 'run_read_only_query', errorCode: 'query_failed' });
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('returns an empty list when the file does not exist and ignores failures', async () => {
    const { audit } = await log();
    expect(await audit.read()).toEqual([]);
  });

  it('never records SQL or result rows (schema is fixed)', async () => {
    const { audit, file } = await log();
    await audit.append({ at: 1, clientId: 'c', tool: 'run_read_only_query', connectionId: 'db', result: 'ok', durationMs: 1 });
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('SELECT');
    expect(raw).not.toContain('rows');
  });
});