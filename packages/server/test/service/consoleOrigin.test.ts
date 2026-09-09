import { describe, expect, it } from 'vitest';
import { resolveConsoleOrigin, resolveCorsOrigin } from '../../src/service/consoleOrigin.js';

const DEV = { NODE_ENV: 'development' };
const PROD = { NODE_ENV: 'production' };
const STAGING = { NODE_ENV: 'staging' };
const UNSET = {};

describe('resolveConsoleOrigin', () => {
  it('falls back to localhost in the development profile', () => {
    expect(resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: '' })).toBe('http://localhost:5173');
    expect(resolveConsoleOrigin(DEV)).toBe('http://localhost:5173');
  });

  it('allows http/localhost in development when explicitly set', () => {
    expect(resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: 'http://localhost:5173' })).toBe('http://localhost:5173');
  });

  it('allows loopback hosts in development', () => {
    expect(resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5173');
    expect(resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: 'http://127.1.2.3:5173' })).toBe('http://127.1.2.3:5173');
    expect(resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: 'http://[::1]:5173' })).toBe('http://[::1]:5173');
  });

  it('rejects a non-loopback host in development', () => {
    expect(() => resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: 'http://example.invalid' })).toThrow(/loopback/);
    expect(() => resolveConsoleOrigin({ ...DEV, SMTP_BASE_URL: 'http://126.0.0.1:5173' })).toThrow(/loopback/);
  });

  it('requires SMTP_BASE_URL outside development', () => {
    expect(() => resolveConsoleOrigin(PROD)).toThrow(/SMTP_BASE_URL is required/);
    expect(() => resolveConsoleOrigin(STAGING)).toThrow(/SMTP_BASE_URL is required/);
    expect(() => resolveConsoleOrigin(UNSET)).toThrow(/SMTP_BASE_URL is required/);
  });

  it('rejects non-HTTPS SMTP_BASE_URL outside development', () => {
    expect(() => resolveConsoleOrigin({ ...PROD, SMTP_BASE_URL: 'http://console.example' })).toThrow(/must use https/);
    expect(() => resolveConsoleOrigin({ ...STAGING, SMTP_BASE_URL: 'http://localhost:5173' })).toThrow(/must use https/);
  });

  it('rejects malformed SMTP_BASE_URL outside development', () => {
    expect(() => resolveConsoleOrigin({ ...PROD, SMTP_BASE_URL: 'not a url' })).toThrow(/not a valid absolute URL/);
  });

  it('returns the HTTPS origin in production/staging', () => {
    expect(resolveConsoleOrigin({ ...PROD, SMTP_BASE_URL: 'https://console.example' })).toBe('https://console.example');
    expect(resolveConsoleOrigin({ ...STAGING, SMTP_BASE_URL: 'https://console.example/' })).toBe('https://console.example');
  });

  it('rejects a path-bearing SMTP_BASE_URL outside development', () => {
    expect(() => resolveConsoleOrigin({ ...PROD, SMTP_BASE_URL: 'https://console.example/some/path' })).toThrow(/bare origin/);
    expect(() => resolveConsoleOrigin({ ...STAGING, SMTP_BASE_URL: 'https://console.example/some/path' })).toThrow(/bare origin/);
  });

  it('rejects query or fragment in SMTP_BASE_URL outside development', () => {
    expect(() => resolveConsoleOrigin({ ...PROD, SMTP_BASE_URL: 'https://console.example?x=1' })).toThrow(/bare origin/);
    expect(() => resolveConsoleOrigin({ ...PROD, SMTP_BASE_URL: 'https://console.example#frag' })).toThrow(/bare origin/);
  });
});

describe('resolveCorsOrigin', () => {
  it('allows the Vite loopback 5173 origins in development', () => {
    expect(resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://localhost:5173' })).toBe('http://localhost:5173');
    expect(resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'https://localhost:5173' })).toBe('https://localhost:5173');
    expect(resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5173');
    expect(resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'https://127.0.0.1:5173' })).toBe('https://127.0.0.1:5173');
    expect(resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://[::1]:5173' })).toBe('http://[::1]:5173');
    expect(resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'https://[::1]:5173' })).toBe('https://[::1]:5173');
    expect(resolveCorsOrigin({ ...DEV })).toBe('http://localhost:5173');
  });

  it('rejects non-5173 loopback ports in development', () => {
    expect(() => resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://localhost:3000' })).toThrow(/loopback/);
    expect(() => resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://127.0.0.1:8080' })).toThrow(/loopback/);
    expect(() => resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://127.1.2.3:5173' })).toThrow(/loopback/);
  });

  it('rejects a non-loopback host in development', () => {
    expect(() => resolveCorsOrigin({ ...DEV, SMTP_BASE_URL: 'http://example.invalid' })).toThrow(/loopback/);
  });

  it('disables CORS outside development', () => {
    expect(resolveCorsOrigin({ ...PROD, SMTP_BASE_URL: 'https://console.example' })).toBe(false);
    expect(resolveCorsOrigin({ ...STAGING, SMTP_BASE_URL: 'https://console.example' })).toBe(false);
    expect(resolveCorsOrigin(UNSET)).toBe(false);
  });
});