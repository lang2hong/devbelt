import { describe, expect, it } from 'vitest';
import { toCsv, auditDto } from '../../src/service/auditSerialize.js';
import type { AuditEvent } from '../../src/domain/entities.js';

function event(over: Partial<AuditEvent>): AuditEvent {
  return {
    id: 1,
    eventTime: new Date('2026-01-01T00:00:00.000Z'),
    actorUserId: 2,
    actorRole: 'platform_admin',
    eventType: 'admin.user.disabled',
    targetType: 'user',
    targetId: '5',
    organizationId: null,
    sourceIp: null,
    requestId: null,
    result: 'success',
    failureCode: null,
    reason: 'abuse',
    createTime: new Date(),
    ...over,
  };
}

describe('toCsv formula injection', () => {
  it('prefixes leading = + - @ with a single quote', () => {
    expect(toCsv([{ reason: '=HYPERLINK("http://x")' }])).toContain("'=HYPERLINK");
    expect(toCsv([{ reason: '+cmd' }])).toContain("'+cmd");
    expect(toCsv([{ reason: '-2+3' }])).toContain("'-2+3");
    expect(toCsv([{ reason: '@foo' }])).toContain("'@foo");
  });

  it('prefixes values whose leading whitespace hides a formula trigger', () => {
    expect(toCsv([{ reason: '  =HYPERLINK("http://x")' }])).toContain("'  =HYPERLINK");
  });

  it('leaves normal values untouched', () => {
    expect(toCsv([{ reason: 'abuse' }])).toContain('"abuse"');
    expect(toCsv([{ reason: 'abuse' }])).not.toContain("'abuse");
  });

  it('escapes double quotes', () => {
    expect(toCsv([{ reason: 'say "hi"' }])).toContain('"say ""hi"""');
  });
});

describe('auditDto', () => {
  it('serializes ids to strings and nulls safely', () => {
    const dto = auditDto(event({}));
    expect(dto.eventId).toBe('1');
    expect(dto.actorUserId).toBe('2');
    expect(dto.organizationId).toBeNull();
    expect(dto.eventTime).toBe('2026-01-01T00:00:00.000Z');
  });
});