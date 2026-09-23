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
 *
 * 编码注意（两处都曾出错）：
 *  - path 里的 label 必须手动 `encodeURIComponent`（URL 的 path 不会自动编码）；
 *  - query 参数逐个 `encodeURIComponent`，严格 RFC 3986。**不要**用 `URLSearchParams`：
 *    它按 form 约定把空格编成 `+`，且若先 encodeURIComponent 再交给它还会**双重编码**
 *    （`中文` → `%25E4%25B8...`，reimport 丢真值）。
 */

import { canonicalizeSecret, stripZeroWidth } from './totp';
import type { TotpAlgorithm } from './types';

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
  let u: URL;
  try {
    u = new URL(cleaned);
  } catch {
    throw new Error('invalid otpauth URI');
  }
  if (u.protocol !== 'otpauth:') throw new Error('invalid otpauth protocol');
  const type = u.host;
  if (type !== 'totp') throw new Error(`unsupported otp type: ${type}`);
  // pathname 形如 "/Google:alice"，剥掉前导 '/'；label 里的裸 '%' 会让 decodeURIComponent 抛 URIError，
  // 统一转换成可读错误，避免 S2 收到不透明异常。只切第一个 ':'，避免 account 内冒号被切坏。
  let rawLabel: string;
  try {
    rawLabel = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('invalid otpauth URI');
  }
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
  // label 在 path 中，需手动编码；account 非空才拼 "issuer:account"，避免 "issuer:" 形式。
  // 注意（固有限制）：account 为空时 label 只放 issuer，解析回来会被当作 account——
  // otpauth 标签格式没有"空 account"的表达方式，导出/回导对 (issuer, account='') 不对称。
  const label = (input.account ?? '') !== ''
    ? `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account!)}`
    : encodeURIComponent(input.issuer);
  // query 参数逐个 encodeURIComponent，严格按 RFC 3986（空格→%20、'+'→%2B）。
  // 不用 URLSearchParams：它按 application/x-www-form-urlencoded 把空格编成 '+'，
  // 严格 URI 解析器会把 '+' 读成字面加号，导致第三方验证器 issuer 失真。
  const qs = [
    ['secret', input.secret],
    ['issuer', input.issuer],
    ['algorithm', algorithm],
    ['digits', String(digits)],
    ['period', String(period)],
  ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `otpauth://totp/${label}?${qs}`;
}
