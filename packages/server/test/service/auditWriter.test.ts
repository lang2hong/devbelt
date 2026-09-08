import { describe, expect, it } from 'vitest';
import { AuditWriter, redactIp } from '../../src/service/auditWriter.js';
import { FakeAuditRepo } from '../helpers/linkFlowFakes.js';

describe('AuditWriter', () => {
  it('writes whitelisted events with sanitized + redacted fields', async () => {
    const repo = new FakeAuditRepo();
    const writer = new AuditWriter(repo);
    writer.write({ eventType: 'email.verify.consumed', result: 'success', sourceIp: '1.2.3.4', requestId: 'r1' });

    // auditWriter 内部异步写入；稍等让 Promise 微任务完成。
    await new Promise((r) => setTimeout(r, 0));

    expect(repo.events).toHaveLength(1);
    expect(repo.events[0].eventType).toBe('email.verify.consumed');
    expect(repo.events[0].result).toBe('success');
    expect(repo.events[0].sourceIp).toBe('1.2.3.0');
  });

  it('drops non-whitelisted event types', async () => {
    const repo = new FakeAuditRepo();
    const writer = new AuditWriter(repo);
    writer.write({ eventType: 'secret.password' as any, result: 'success' });
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.events).toHaveLength(0);
  });
});

describe('redactIp', () => {
  it('zeros the last IPv4 octet', () => {
    expect(redactIp('198.51.100.23')).toBe('198.51.100.0');
  });

  it('keeps first 4 groups of a full eight-group IPv6', () => {
    expect(redactIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3:0000::');
  });

  it('redacts a compressed IPv6 address', () => {
    expect(redactIp('2001:db8::1')).toBe('2001:db8:0:0::');
  });

  it('redacts an IPv4-mapped IPv6 address', () => {
    expect(redactIp('::ffff:192.0.2.1')).toBe('0:0:0:0::');
  });

  it('passes through null and unrecognised values', () => {
    expect(redactIp(null)).toBeNull();
    expect(redactIp(undefined)).toBeNull();
    expect(redactIp('not an ip')).toBe('not an ip');
  });
});