import { randomBytes } from 'node:crypto';

/**
 * 反馈回复凭证：每个安装一把 32 字节随机 key（base64url，43 字符）。
 *
 * - 存 `SecretStorage`（属于安装，不属于账号；切换账号不丢）。
 * - 服务端只存 SHA-256；凭 `installId + replyKey` 读取本安装匿名提交的反馈与回复。
 * - SecretStorage 不可用（如 Linux 无 keyring）时返回 undefined：反馈照常提交，
 *   只是没有匿名站内线程（登录用户仍可按账号查看）。
 */
export const REPLY_KEY_SECRET = 'devbelt.feedback.replyKey';

const REPLY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SecretStoreLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

/** 只读：不存在或不可用时返回 undefined，不生成新 key。 */
export async function readReplyKey(secrets: SecretStoreLike): Promise<string | undefined> {
  try {
    const v = await secrets.get(REPLY_KEY_SECRET);
    return v && REPLY_KEY_PATTERN.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 读取或生成；写入后回读确认，失败返回 undefined。 */
export async function getOrCreateReplyKey(secrets: SecretStoreLike): Promise<string | undefined> {
  const existing = await readReplyKey(secrets);
  if (existing) return existing;
  const key = randomBytes(32).toString('base64url');
  try {
    await secrets.store(REPLY_KEY_SECRET, key);
  } catch {
    return undefined;
  }
  // 两个窗口同时首次生成时以最终落盘值为准，避免本窗口用了一把被覆盖的 key。
  return readReplyKey(secrets);
}
