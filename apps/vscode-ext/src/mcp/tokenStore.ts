import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface McpClientToken {
  id: string;
  name: string;
  createdAt: number;
}

export interface McpTokenStorage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface McpSecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const INDEX_KEY = 'devbelt.mcp.clients';
const SECRET_PREFIX = 'devbelt.mcp.token.';

/**
 * Per-client bearer tokens. Only a sha256 hash is stored (SecretStorage); the
 * plaintext is returned once, when the client is created.
 */
export class McpTokenStore {
  constructor(private readonly memento: McpTokenStorage, private readonly secrets: McpSecretStorage) {}

  list(): McpClientToken[] {
    return this.memento.get<McpClientToken[]>(INDEX_KEY, []).map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  async create(name: string): Promise<{ client: McpClientToken; token: string }> {
    const label = name.trim() || 'MCP client';
    const token = randomBytes(32).toString('base64url');
    const client: McpClientToken = { id: randomUUID(), name: label, createdAt: Date.now() };
    await this.secrets.store(`${SECRET_PREFIX}${client.id}`, hash(token));
    await this.memento.update(INDEX_KEY, [...this.list(), client]);
    return { client, token };
  }

  async revoke(id: string): Promise<void> {
    await this.secrets.delete(`${SECRET_PREFIX}${id}`);
    await this.memento.update(INDEX_KEY, this.list().filter((c) => c.id !== id));
  }

  async revokeAll(): Promise<void> {
    for (const client of this.list()) await this.revoke(client.id);
  }

  /** Returns the client id for a valid token, or undefined. */
  async verify(token: string): Promise<string | undefined> {
    if (!token) return undefined;
    const digest = Buffer.from(hash(token), 'hex');
    for (const client of this.list()) {
      const stored = await this.secrets.get(`${SECRET_PREFIX}${client.id}`);
      if (!stored) continue;
      const expected = Buffer.from(stored, 'hex');
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) return client.id;
    }
    return undefined;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}