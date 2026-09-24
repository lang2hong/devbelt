import { decodeBase32Loose, encodeBase32UpperCaseNoPadding } from './base32';

/**
 * 验证器 secret 规范化（宿主无关，P6-S5c 从 vscode-ext/totp.ts 抽出，供扩展与 Web 共用）。
 *
 * 零宽字符（otpauth URI 解析入口先剥一次）。注意 JS `\s` 会匹配 `\uFEFF`，但不匹配
 * `\u200B/\u200C/\u200D`，故显式兜底。
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

/** 剥掉零宽字符；otpauth URI 解析入口用。 */
export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_RE, '');
}

/**
 * 归一化 secret：剥所有 JS `\s` 空白 → base32 解码 → 重新编码为大写、无 padding 的规范形态。
 * 解码非法字符/长度抛错；空串解码为空字节（由调用方负责拒绝空 secret）。
 */
export function canonicalizeSecret(input: string): string {
  const stripped = input.replace(/\s+/g, '');
  const bytes = decodeBase32Loose(stripped);
  return encodeBase32UpperCaseNoPadding(bytes);
}
