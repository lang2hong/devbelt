/** 测试数据骨架生成（e2e 邮件链路共用）。 */

const PASSWORD = 'correct-horse-battery';

export function uniqueEmail() {
  return `e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;
}

export { PASSWORD };

/** 轮询 Mailpit HTTP API，取发给该邮箱的验证邮件，提取 `/verify-email?token=...` 链接。 */
export async function getVerificationLink(email, mailpitBase = process.env.MAILPIT_HTTP ?? 'http://localhost:8025') {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const search = await fetch(`${mailpitBase}/api/v1/search?query=to:${encodeURIComponent(email)}`);
      if (search.ok) {
        const { messages } = await search.json();
        if (messages && messages.length > 0) {
          const msg = await fetch(`${mailpitBase}/api/v1/message/${messages[0].ID}`);
          const text = await msg.text();
          const m = text.match(/\/verify-email\?token=[A-Za-z0-9_-]+/);
          if (m) return m[0];
        }
      }
    } catch {
      // Mailpit 尚未就绪，重试。
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`verification email for ${email} not observed in Mailpit`);
}