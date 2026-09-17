import { describe, expect, it } from 'vitest';
import { matchRoute } from './router';

const routes = [
  { pattern: '/account', name: 'account' },
  { pattern: '/organizations', name: 'organizations' },
  { pattern: '/organizations/:id', name: 'organization-detail' },
];

describe('matchRoute', () => {
  it('matches a static route', () => {
    expect(matchRoute('/account', routes)).toEqual({ name: 'account', params: {} });
  });

  it('matches a dynamic param', () => {
    expect(matchRoute('/organizations/42', routes)).toEqual({ name: 'organization-detail', params: { id: '42' } });
  });

  it('prefers the static route over a dynamic sibling on exact match', () => {
    // route order matters: 'organizations' declared before ':id'
    expect(matchRoute('/organizations', routes)).toEqual({ name: 'organizations', params: {} });
  });

  it('returns null on no match', () => {
    expect(matchRoute('/account/extra', routes)).toBeNull();
    expect(matchRoute('/elsewhere', routes)).toBeNull();
  });
});