/**
 * otpauth:// URI 解析与生成（Google Authenticator 事实约定，非 RFC）。
 *
 * 解析流程：trim → 剥零宽字符 → new URL → 校验 scheme=otpauth、type=totp
 * （hotp 直接拒绝）→ label 按第一个 `:` 拆 issuer/account → query 参数读取，
 * secret 走 `canonicalizeSecret` 归一化，算法/位数/周期缺省为 SHA1/6/30。
 *
 * label 切分规则：只切第一个 `:`，避免 account 里含冒号时被切坏；
 * issuer 优先级：query issuer > label 里的 issuerFromLabel > 空串。
 *
 * 生成（导出用）：secret 已是规范化形态，直接拼；account 非空时 label 为
 * `issuer:account`，account 为空时只放 issuer（**不**生成带冒号的空 account）；
 * 算法/位数/周期即使是默认值也显式写出（与主流 app 行为一致）。
 */

import { canonicalizeSecret, stripZeroWidth } from './totp.js';
import type { TotpAlgorithm } from './types.js';

export interface OtpauthParsed {
  issuer: string;
  account: string;
  secret: string; // 规范化形态（大写无空格无 padding base32）
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  period: 30 | 60;
}

const ALLOWED_ALGOS: ReadonlySet<string> = new Set(['SHA1', 'SHA256', 'SHA512']);

export function parseOtpauthUri(uri: string): OtpauthParsed {
  const cleaned = stripZeroWidth(uri.trim());
  const u = new URL(cleaned);
  if (u.protocol !== 'otpauth:') throw new Error('invalid otpauth protocol');
  const type = u.host;
  if (type !== 'totp') throw new Error(`unsupported otp type: ${type}`);
  // pathname 形如 "/Google:alice"，剥掉前导 '/'
  const rawLabel = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const colonIdx = rawLabel.indexOf(':');
  let issuerFromLabel = '';
  let account = '';
  if (colonIdx >= 0) {
    issuerFromLabel = rawLabel.slice(0, colonIdx);
    account = rawLabel.slice(colonIdx + 1);
  } else {
    account = rawLabel;
  }
  const qs = u.searchParams;
  const secretParam = qs.get('secret');
  if (!secretParam) throw new Error('missing secret in otpauth URI');
  const secret = canonicalizeSecret(secretParam); // 解码失败直接抛
  const issuer = qs.get('issuer') ?? issuerFromLabel;
  const algoParam = (qs.get('algorithm') ?? 'SHA1').toUpperCase();
  if (!ALLOWED_ALGOS.has(algoParam)) throw new Error(`invalid algorithm: ${algoParam}`);
  const algorithm = algoParam as TotpAlgorithm;
  const digits = qs.get('digits') === '8' ? 8 : 6;
  const periodNum = qs.get('period') ? parseInt(qs.get('period')!, 10) : 30;
  const period: 30 | 60 = periodNum === 60 ? 60 : 30;
  return { issuer, account, secret, algorithm, digits, period };
}

export function buildOtpauthUri(input: {
  issuer: string;
  account?: string;
  secret: string; // 必须是规范化形态（canonicalizeSecret 输出）
  algorithm?: TotpAlgorithm;
  digits?: 6 | 8;
  period?: 30 | 60;
}): string {
  const algorithm = input.algorithm ?? 'SHA1';
  const digits = input.digits ?? 6;
  const period = input.period ?? 30;
  const encIssuer = encodeURIComponent(input.issuer);
  const encAccount = encodeURIComponent(input.account ?? '');
  // account 非空才拼 "issuer:account"，避免 "issuer:" 形式
  const label = (input.account ?? '') !== '' ? `${encIssuer}:${encAccount}` : encIssuer;
  const qs = new URLSearchParams({
    secret: input.secret,
    issuer: encIssuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}
