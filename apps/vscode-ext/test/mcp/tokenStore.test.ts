import { describe, expect, it } from 'vitest';
import { McpTokenStore } from '../../src/mcp/tokenStore';

function store() {
  const memento = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    tokens: new McpTokenStore(
      { get: <T>(k: string, d: T) => (memento.get(k) as T) ?? d, update: async (k, v) => { memento.set(k, v); } },
      { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    ),
    secrets,
  };
}

describe('McpTokenStore', () => {
  it('creates a token, stores only its hash and verifies it', async () => {
    const { tokens, secrets } = store();
    const { client, token } = await tokens.create('Cursor');
    expect(token.length).toBeGreaterThan(30);
    expect(client.name).toBe('Cursor');
    expect(tokens.list()).toEqual([client]);
    expect([...secrets.values()]).not.toContain(token);
    await expect(tokens.verify(token)).resolves.toBe(client.id);
  });

  it('rejects unknown, empty and revoked tokens', async () => {
    const { tokens } = store();
    const { client, token } = await tokens.create('A');
    await expect(tokens.verify('nope')).resolves.toBeUndefined();
    await expect(tokens.verify('')).resolves.toBeUndefined();
    await tokens.revoke(client.id);
    await expect(tokens.verify(token)).resolves.toBeUndefined();
    expect(tokens.list()).toEqual([]);
  });

  it('keeps other clients valid when one is revoked', async () => {
    const { tokens } = store();
    const a = await tokens.create('A');
    const b = await tokens.create('B');
    await tokens.revoke(a.client.id);
    await expect(tokens.verify(a.token)).resolves.toBeUndefined();
    await expect(tokens.verify(b.token)).resolves.toBe(b.client.id);
  });

  it('returns no match when the secret is missing', async () => {
    const { tokens, secrets } = store();
    const { client, token } = await tokens.create('A');
    secrets.delete(`devbelt.mcp.token.${client.id}`);
    await expect(tokens.verify(token)).resolves.toBeUndefined();
  });
});