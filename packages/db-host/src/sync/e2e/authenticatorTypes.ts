/**
 * 验证器（P5）同步实体的结构化类型与白名单（db-host 侧）。
 *
 * db-host 不得反向依赖 apps/vscode-ext，故在此声明同步链路所需的形状；与扩展侧
 * `apps/vscode-ext/src/authenticator/types.ts` 结构兼容。
 * entry 的 secret 单独走 SecretStorage；同步时以密文进入 payload（见 recordCodec），
 * `localOnly`/`syncError` 为仅本地派生态，**不进 payload**。
 */

export type AuthenticatorAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
export const AUTHENTICATOR_ALGORITHMS: readonly AuthenticatorAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];

export const AUTHENTICATOR_TAG_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'cyan', 'gray'] as const;
export type AuthenticatorTagColor = typeof AUTHENTICATOR_TAG_COLORS[number];

export interface SyncAuthenticatorGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface SyncAuthenticatorTag {
  id: string;
  name: string;
  color: AuthenticatorTagColor;
}

export interface SyncAuthenticatorEntry {
  id: string;
  issuer: string;
  account?: string;
  algorithm: AuthenticatorAlgorithm;
  digits: 6 | 8;
  period: 30 | 60;
  groupId?: string;
  tags: string[];
  createTime: number;
  updateTime: number;
  /** 仅本地派生态（不进 payload）。 */
  localOnly?: boolean;
  syncError?: 'quota';
}

/** 同步管道中的 entry 值：附带从 SecretStorage 取出的规范化 secret（仅用于组 payload）。 */
export interface SyncAuthenticatorEntryValue extends SyncAuthenticatorEntry {
  secret?: string;
}

export const AUTHENTICATOR_SECRET_MAX_CHARS = 512;
export const AUTHENTICATOR_SECRET_RE = /^[A-Z2-7]+$/;

export function assertAuthenticatorSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !AUTHENTICATOR_SECRET_RE.test(secret) || secret.length > AUTHENTICATOR_SECRET_MAX_CHARS) {
    throw new Error('invalid authenticator secret');
  }
  return secret;
}

export function assertAuthenticatorAlgorithm(v: unknown): AuthenticatorAlgorithm {
  if (v === 'SHA1' || v === 'SHA256' || v === 'SHA512') return v;
  throw new Error(`invalid authenticator algorithm: ${String(v)}`);
}

export function assertAuthenticatorDigits(v: unknown): 6 | 8 {
  if (v === 6 || v === 8) return v;
  throw new Error(`invalid authenticator digits: ${String(v)}`);
}

export function assertAuthenticatorPeriod(v: unknown): 30 | 60 {
  if (v === 30 || v === 60) return v;
  throw new Error(`invalid authenticator period: ${String(v)}`);
}

export function assertAuthenticatorTagColor(v: unknown): AuthenticatorTagColor {
  if (typeof v === 'string' && (AUTHENTICATOR_TAG_COLORS as readonly string[]).includes(v)) return v as AuthenticatorTagColor;
  throw new Error(`invalid authenticator tag color: ${String(v)}`);
}
