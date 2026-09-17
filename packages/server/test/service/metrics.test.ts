import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { MetricsRegistry, attachRequestMetrics } from '../../src/service/metrics.js';

describe('MetricsRegistry', () => {
  it('increments and snapshots counters', () => {
    const m = new MetricsRegistry();
    m.increment('http:GET:/x:200');
    m.increment('http:GET:/x:200');
    m.increment('http:POST:/x:500', 3);
    expect(m.snapshot()).toEqual({ 'http:GET:/x:200': 2, 'http:POST:/x:500': 3 });
  });

  it('builds the canonical (method, route, status) key', () => {
    const m = new MetricsRegistry();
    expect(m.requestKey('GET', '/api/db/sync/state', 200)).toBe('http:GET:/api/db/sync/state:200');
  });
});

describe('attachRequestMetrics', () => {
  async function build() {
    const app = Fastify({ logger: false });
    const metrics = new MetricsRegistry();
    attachRequestMetrics(app, metrics);
    app.get('/users/:id', async () => ({ ok: true }));
    await app.ready();
    return { app, metrics };
  }

  it('counts matched requests by normalized route, not by id variant', async () => {
    const { app, metrics } = await build();
    await app.inject({ method: 'GET', url: '/users/42' });
    await app.inject({ method: 'GET', url: '/users/999' });

    expect(metrics.snapshot()['http:GET:/users/:id:200']).toBe(2);
    const keys = Object.keys(metrics.snapshot()).join(' ');
    expect(keys).not.toContain('42');
    expect(keys).not.toContain('999');
    await app.close();
  });

  it('does not leak query tokens into unmatched-path keys', async () => {
    const { app, metrics } = await build();
    await app.inject({ method: 'GET', url: '/nope?token=SECRET123' });

    const keys = Object.keys(metrics.snapshot()).join(' ');
    expect(keys).not.toContain('SECRET123');
    expect(keys).toContain('http:GET:/nope:404');
    await app.close();
  });
});