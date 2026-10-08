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
  // separator 也要转义：它可能被设成 glob 元字符（`* ? [`），否则按前缀删除会误伤无关键。
  return `${escapeRedisGlob(prefix)}${escapeRedisGlob(separator)}*`;
}

/**
 * 「按 pattern 删除」输入框预填（B 决策）：
 *  - 键节点 → 转义后的键名（精确）；
 *  - 文件夹节点 → 转义的 prefix + sep + `*`（等价于删该文件夹）；
 *  - 其它（db/连接）→ 空串（**逼迫用户显式输入**，避免把「删整库」的 `*` 直接递给用户）。
 * 预填仅转义字面部分，`*` 为有意保留的通配。
 */
export function deletePatternPrefill(redisKey?: string, prefix?: string, separator = ':'): string {
  if (redisKey) return escapeRedisGlob(redisKey);
  if (prefix) return redisPrefixPattern(prefix, separator);
  return '';
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
 * **调用契约**：只处理真正属于该前缀的键——`prefix` 非空时，不以 `prefix+separator`
 * 开头的键一律忽略。否则 D* 的根扁平集里「同前缀字符串但不同层」的键（如 `ab:y` 之于
 * 前缀 `a`、`user` 之于前缀 `user`）会以完整键名被反复折叠成子文件夹，导致父↔子无限循环。
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
    if (base && !k.startsWith(base)) continue;
    const rel = base ? k.slice(base.length) : k;
    const idx = separator ? rel.indexOf(separator) : -1;
    // 仅当分隔符**后还有内容**才算折叠成文件夹；`a:` 这类「以分隔符结尾」的键应作为叶子
    // 显示，否则它既不做文件夹（子层为空）也不会成为叶子，直接消失。
    const isFolder = idx > 0 && idx < rel.length - separator.length;
    if (isFolder) {
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
