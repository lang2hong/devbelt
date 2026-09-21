import { afterEach, describe, expect, it } from 'vitest';
import {
  secureCookiesEnabled,
  linkFlowCookieName,
  csrfCookieName,
  serializeCookie,
  readCookie,
} from '../../src/middleware/cookies.js';

const OLD_NODE_ENV = process.env.NODE_ENV;
const OLD_SMTP_BASE_URL = process.env.DEVBELT_DB_SMTP_BASE_URL;

afterEach(() => {
  if (OLD_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = OLD_NODE_ENV;
  if (OLD_SMTP_BASE_URL === undefined) delete process.env.DEVBELT_DB_SMTP_BASE_URL;
  else process.env.DEVBELT_DB_SMTP_BASE_URL = OLD_SMTP_BASE_URL;
});

describe('cookie security profile', () => {
  it('uses insecure dev_ cookies only in development on a loopback host', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEVBELT_DB_SMTP_BASE_URL = 'http://localhost:5173';

    expect(secureCookiesEnabled()).toBe(false);
    expect(linkFlowCookieName()).toBe('dev_devbelt_link_flow');
    expect(csrfCookieName()).toBe('dev_devbelt_csrf');
    expect(serializeCookie(linkFlowCookieName(), 'n', { httpOnly: true })).not.toContain('Secure');
  });

  it('uses secure __Host- cookies in development on a non-loopback host', () => {
    process.env.NODE_ENV = 'development';
    process.env.DEVBELT_DB_SMTP_BASE_URL = 'http://console.example';

    expect(secureCookiesEnabled()).toBe(true);
    expect(linkFlowCookieName()).toBe('__Host-devbelt_link_flow');
    expect(serializeCookie(linkFlowCookieName(), 'n', { httpOnly: true })).toContain('Secure');
    expect(serializeCookie(linkFlowCookieName(), 'n', { httpOnly: true })).toContain('HttpOnly');
  });

  it('uses secure __Host- cookies in staging (not development)', () => {
    process.env.NODE_ENV = 'staging';
    process.env.DEVBELT_DB_SMTP_BASE_URL = 'http://localhost:5173';

    expect(secureCookiesEnabled()).toBe(true);
    expect(linkFlowCookieName()).toBe('__Host-devbelt_link_flow');
    expect(csrfCookieName()).toBe('__Host-devbelt_csrf');
  });
});
describe('readCookie', () => {
  const req = (cookie: string) => ({ headers: { cookie } }) as never;

  it('returns the decoded value', () => {
    expect(readCookie(req('a=1; session=abc'), 'session')).toBe('abc');
  });

  it('returns undefined (no throw) for malformed percent-encoding', () => {
    expect(readCookie(req('session=%'), 'session')).toBeUndefined();
    expect(readCookie(req('session=%zz'), 'session')).toBeUndefined();
  });

  it('returns undefined for values containing control characters', () => {
    expect(readCookie(req('session=a%0Ab'), 'session')).toBeUndefined();
  });

  it('returns undefined when the cookie is absent or the header is missing', () => {
    expect(readCookie(req('other=1'), 'session')).toBeUndefined();
    expect(readCookie({ headers: {} } as never, 'session')).toBeUndefined();
  });
});
