import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  env: { language: 'en' },
}));

import { currentPgSchema } from '../../src/commands/dictionary';

describe('currentPgSchema (L2)', () => {
  it('returns current_schema() without recording history', async () => {
    const query = vi.fn(async () => ({ rows: [{ s: 'sales' }] }));
    expect(await currentPgSchema({ query: { query } })).toBe('sales');
    expect(query).toHaveBeenCalledWith('SELECT current_schema() AS s', undefined, { skipHistory: true });
  });

  it('returns undefined when the query fails or yields nothing', async () => {
    expect(await currentPgSchema({ query: { query: vi.fn(async () => { throw new Error('x'); }) } })).toBeUndefined();
    expect(await currentPgSchema({ query: { query: vi.fn(async () => ({ rows: [{ s: null }] })) } })).toBeUndefined();
  });
});
