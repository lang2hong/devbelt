import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export interface McpAuditEntry {
  at: number;
  clientId: string;
  tool: string;
  connectionId: string;
  result: 'ok' | 'error' | 'rejected';
  durationMs: number;
  rows?: number;
  errorCode?: string;
}

/** Append-only audit for MCP calls. No SQL text, arguments or result rows. */
export class McpAuditLog {
  constructor(private readonly path: string) {}

  async append(entry: McpAuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    try {
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const handle = await fs.open(this.path, 'a', 0o600);
      try {
        await handle.appendFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Audit is best effort for reads, but the caller still gets the result.
    }
  }

  async read(): Promise<McpAuditEntry[]> {
    try {
      const text = await fs.readFile(this.path, 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as McpAuditEntry);
    } catch {
      return [];
    }
  }
}