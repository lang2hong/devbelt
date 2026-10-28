import { describe, it, expect } from 'vitest';
import { SmtpEmailSender } from '../../src/modules/auth/service/smtpEmailSender.js';

/** 替换内部 transporter，只捕获 sendMail 参数，不发起任何网络连接。 */
function makeSender() {
  const sender = new SmtpEmailSender({
    DEVBELT_DB_SMTP_HOST: '127.0.0.1',
    DEVBELT_DB_SMTP_FROM: 'no-reply@example.test',
  } as NodeJS.ProcessEnv);
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  (sender as unknown as { transporter: { sendMail: (m: unknown) => Promise<void> } }).transporter = {
    sendMail: async (m: unknown) => { sent.push(m as (typeof sent)[number]); },
  };
  return { sender, sent };
}

describe('SmtpEmailSender.sendFeedbackReplyEmail', () => {
  it('HTML 中转义回复与原反馈，纯文本保留原文', async () => {
    const { sender, sent } = makeSender();
    await sender.sendFeedbackReplyEmail({
      to: 'u@example.test',
      reply: '<script>alert(1)</script>\n已修复 & 发布',
      originalContent: '<img src=x onerror=alert(2)>',
    });
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe('u@example.test');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).toContain('已修复 &amp; 发布');
    expect(mail.text).toContain('<script>alert(1)</script>');
  });

  it('原反馈过长时截断', async () => {
    const { sender, sent } = makeSender();
    await sender.sendFeedbackReplyEmail({ to: 'u@example.test', reply: 'ok', originalContent: 'x'.repeat(800) });
    expect(sent[0]!.text).toContain(`${'x'.repeat(500)}…`);
    expect(sent[0]!.text).not.toContain('x'.repeat(501));
  });
});
