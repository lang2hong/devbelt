/**
 * Redis 键名工具（P7 S5-3）：搜索匹配、前缀 pattern（含 glob 转义）、
 * 以及把某前缀下的 key 归成「直接文件夹 + 直接叶子」。纯函数、零 IO，便于单测。
 */

/** 转义 Redis glob 特殊字符（`\ * ? [ ] ^`），使其在 `MATCH` 中按字面匹配。 */
export function escapeRedisGlob(input: string): string {
  return input.replace(/[\\*?[\]^]/g, (ch) => `\\${ch}`);
}

/**
 * 把用户搜索词转成 Redis `SCAN MATCH` 的包含模式（模糊搜索）。
 *
 * 转义 glob 特殊字符后两侧包 `*` → 子串包含；空/纯空白 → undefined（不施加 match）。
 */
export function toRedisMatchPattern(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  return `*${escapeRedisGlob(trimmed)}*`;
}

/**
 * 前缀 pattern：转义前缀后加 `<separator>*`（供文件夹展开 SCAN 与按前缀删除）。
 *
 * **必须转义**：文件夹名可能含 glob 元字符（如 `a[1]`），不转义会被 Redis 当字符类，
 * 命中错误键集合（删除路径即数据丢失）。
 */
export function redisPrefixPattern(prefix: string, separator = ':'): string {
  return `${escapeRedisGlob(prefix)}${separator}*`;
}

export interface RedisKeyChildGroup {
  /** 直接子文件夹（相对名 + 绝对前缀）。 */
  folders: { name: string; prefix: string }[];
  /** 直接叶子键（完整 key）。 */
  keys: string[];
}

/**
 * 把某前缀下已加载的 key 归成「直接子文件夹 + 直接叶子键」（S5-3 树懒加载）。
 *
 * key 去掉 `prefix+separator` 后仍含分隔符 → 归入首个段为名的文件夹；否则为叶子。
 * 文件夹与叶子各自按名升序。纯函数，供树 provider 与单测复用。
 */
export function groupRedisKeyChildren(
  keys: readonly string[],
  prefix = '',
  separator = ':',
): RedisKeyChildGroup {
  const base = prefix ? `${prefix}${separator}` : '';
  const folderMap = new Map<string, string>();
  const outKeys: string[] = [];
  for (const k of keys) {
    const rel = base && k.startsWith(base) ? k.slice(base.length) : k;
    const idx = separator ? rel.indexOf(separator) : -1;
    if (idx > 0) {
      const name = rel.slice(0, idx);
      if (!folderMap.has(name)) folderMap.set(name, `${base}${name}`);
    } else if (rel) {
      outKeys.push(k);
    }
  }
  const folders = [...folderMap.entries()]
    .map(([name, p]) => ({ name, prefix: p }))
    .sort((a, b) => a.name.localeCompare(b.name));
  outKeys.sort();
  return { folders, keys: outKeys };
}
