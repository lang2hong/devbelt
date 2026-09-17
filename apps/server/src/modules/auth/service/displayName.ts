import { ValidationError } from '../../../domain/errors.js';

/**
 * 显示名校验/规整（§4.4）：1..100 Unicode code points。
 *
 * - 去除首尾空白、控制字符、零宽字符（200B-200F、FEFF）。
 * - 规整后不得为空。
 * - 长度按 Unicode code point 计数（emoji 代理对算 1），非 UTF-16 单元。
 * register 与 PATCH /api/console/me 共用（§4.2「displayName 校验同 PATCH /me」）。
 */
export function sanitizeDisplayName(raw: string): string {
  const trimmed = Array.from(raw)
    .filter((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return !(cp < 0x20 || cp === 0x7f || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff);
    })
    .join('')
    .trim();
  const len = Array.from(trimmed).length;
  if (len < 1 || len > 100) {
    throw new ValidationError('displayName must be 1..100 characters');
  }
  return trimmed;
}