import { describe, expect, it } from 'vitest';
import { matchRoute } from './router';

const routes = [
  { pattern: '/console/account', name: 'account' },
  { pattern: '/console/orders', name: 'orders' },
  { pattern: '/console/orders/:id', name: 'order-detail' },
];

describe('matchRoute', () => {
  it('matches a static route', () => {
    expect(matchRoute('/console/account', routes)).toEqual({ name: 'account', params: {} });
  });

  it('matches a dynamic param', () => {
    expect(matchRoute('/console/orders/42', routes)).toEqual({ name: 'order-detail', params: { id: '42' } });
  });

  it('prefers the static route over a dynamic sibling on exact match', () => {
    // route order matters: 'orders' declared before ':id'
    expect(matchRoute('/console/orders', routes)).toEqual({ name: 'orders', params: {} });
  });

  it('returns null on no match', () => {
    expect(matchRoute('/console/account/extra', routes)).toBeNull();
    expect(matchRoute('/elsewhere', routes)).toBeNull();
  });
});