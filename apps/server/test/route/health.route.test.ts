import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerHealthRoutes } from '../../src/route/health.js';
import type { Migration } from '../../src/repository/mysql/migrate.js';
import type { Queryable } from '../../src/repository/mysql/db.js';

const MIGS: Migration[] = [
  { version: '001_users', up: async () => {} },
  { version: '002_sync', up: async () => {} },
];

function fakeDb(opts: { applied: string[]; failPing?: boolean }) {
  const query = vi.fn(async (sql: string) => {
    if (opts.failPing) throw new Error('db down');
    if (sql.includes('schema_migrations')) {
      return [opts.applied.map((v) => ({ version: v })), []] as unknown;
    }
    return [null, []] as unknown;
  });
  return { query: query as unknown as Queryable['query'] } as Queryable;
}

async function build(applied = MIGS.map((m) => m.version), failPing = false) {
  const app = Fastify({ logger: false });
  await app.register(registerHealthRoutes, {
    migrations: MIGS,
    getDb: () => fakeDb({ applied, failPing }),
    mailReady: true,
  });
  return app;
}

describe('health routes', () => {
  it('/health/live returns 200 ok with no-store and no cookie', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('/health/ready returns 200 with all deps ok when db + schema + mail ready', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok', schema: 'ok', mail: 'ok' });
    await app.close();
  });

  it('/health/ready returns 503 when the database is down', async () => {
    const app = await build(MIGS.map((m) => m.version), true);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().db).toBe('down');
    expect(res.json().schema).toBe('down');
    await app.close();
  });

  it('/health/ready returns 503 when schema is not fully applied', async () => {
    const app = await build(['001_users']);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().db).toBe('ok');
    expect(res.json().schema).toBe('pending');
    await app.close();
  });

  it('/health/ready treats legacy ${version}_v3 ledger entries as applied', async () => {
    const app = await build(['001_users_v3', '002_sync']);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().schema).toBe('ok');
    await app.close();
  });

  it('/health/ready returns 503 when the ledger has an unknown (newer) migration', async () => {
    const app = await build(['001_users', '002_sync', '999_future']);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().schema).toBe('pending');
    await app.close();
  });

  it('/health/ready never leaks schema version strings', async () => {
    const app = await build(['001_users']);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = res.body;
    expect(body).not.toContain('002_sync');
    expect(body.length).toBeLessThan(500);
    await app.close();
  });
});