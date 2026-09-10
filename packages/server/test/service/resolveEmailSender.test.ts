import { describe, it, expect } from 'vitest';
import { resolveEmailSender } from '../../src/service/resolveEmailSender.js';
import { LogEmailSender } from '../../src/service/emailSender.js';
import { SmtpEmailSender } from '../../src/service/smtpEmailSender.js';

describe('resolveEmailSender', () => {
  it('throws in production without SMTP_HOST', () => {
    expect(() => resolveEmailSender({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/SMTP_HOST is required/);
  });

  it('returns LogEmailSender in non-production without SMTP', () => {
    expect(resolveEmailSender({} as NodeJS.ProcessEnv)).toBeInstanceOf(LogEmailSender);
  });

  it('returns LogEmailSender in non-production even when SMTP_HOST is set (never sends real mail)', () => {
    const sender = resolveEmailSender({ SMTP_HOST: 'smtp.example.com' } as NodeJS.ProcessEnv);
    expect(sender).toBeInstanceOf(LogEmailSender);
  });

  it('returns an (insecure, localhost-only) SmtpEmailSender for MAILER=mailpit', () => {
    const sender = resolveEmailSender({ MAILER: 'mailpit' } as NodeJS.ProcessEnv);
    expect(sender).toBeInstanceOf(SmtpEmailSender);
  });
});