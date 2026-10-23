import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import type { ConnectionManager } from '../connection/connectionManager.js';
import type { McpAuditLog } from './audit.js';
import type { McpTokenStore } from './tokenStore.js';
import { buildMcpTools, type McpTool } from './tools.js';

export interface McpServerSettings {
  rateLimitPerMinute: number;
  includeSample: boolean;
  maxRows: number;
}

export interface McpServerDeps {
  tokens: McpTokenStore;
  audit: McpAuditLog;
  manager: ConnectionManager;
  getConnection(): SavedConnection | undefined;
  getSettings(): McpServerSettings;
}

const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 30_000;

/** Loopback-only MCP server for one configured connection. */
export class McpServerHost {
  private server?: Server;
  private port?: number;
  private readonly rate = new Map<string, { window: number; count: number }>();

  constructor(private readonly deps: McpServerDeps) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  get endpoint(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined;
  }

  async start(): Promise<string> {
    if (this.server) return this.endpoint!;
    const conn = this.deps.getConnection();
    if (!conn) throw new Error('MCP requires a configured connection');
    if (conn.dbType !== 'MYSQL' && conn.dbType !== 'PG' && conn.dbType !== 'SQLITE') {
      throw new Error(`MCP does not support ${conn.dbType}`);
    }

    const server = createServer((req, res) => { void this.handle(req, res); });
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('MCP failed to bind a loopback port');
    }
    this.server = server;
    this.port = address.port;
    return this.endpoint!;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.rate.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
        return send(res, 404, { error: 'not_found' });
      }
      if (!this.validHost(req)) return send(res, 403, { error: 'bad_host' });
      if (!this.validOrigin(req)) return send(res, 403, { error: 'bad_origin' });
      const token = bearer(req);
      const clientId = token ? await this.deps.tokens.verify(token) : undefined;
      if (!clientId) return send(res, 401, { error: 'unauthorized' });
      if (!this.allow(clientId)) return send(res, 429, { error: 'rate_limited' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { error: 'content_type' });
      }

      const body = await readJson(req);
      const conn = this.deps.getConnection();
      if (!conn) return send(res, 503, { error: 'no_connection' });

      const tools = buildMcpTools({
        conn,
        ...(conn.database ? { database: conn.database } : {}),
        ...(conn.schema ? { schema: conn.schema } : {}),
        clientId,
        includeSample: this.deps.getSettings().includeSample,
        maxRows: this.deps.getSettings().maxRows,
        audit: this.deps.audit,
        openSession: async () => {
          const opened = await this.deps.manager.openIsolatedSql(conn);
          return { session: opened.session, close: opened.close };
        },
      });

      const mcp = new McpServer({ name: 'devbelt', version: '0.3.0' });
      register(mcp, tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      try {
        await transport.handleRequest(req, res, body);
      } finally {
        await transport.close().catch(() => undefined);
        await mcp.close().catch(() => undefined);
      }
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
      else res.end();
      void err;
    }
  }

  private validHost(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private validOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    // Desktop MCP clients normally send no Origin; allow only local VS Code webviews.
    return origin.startsWith('vscode-webview://');
  }

  private allow(clientId: string): boolean {
    const limit = Math.max(1, this.deps.getSettings().rateLimitPerMinute);
    const now = Math.floor(Date.now() / 60_000);
    const entry = this.rate.get(clientId);
    if (!entry || entry.window !== now) {
      this.rate.set(clientId, { window: now, count: 1 });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }
}

function register(mcp: McpServer, tools: readonly McpTool[]): void {
  for (const tool of tools) {
    mcp.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, async (args: Record<string, unknown>) => tool.handler(args ?? {}));
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1]?.trim() || undefined;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}