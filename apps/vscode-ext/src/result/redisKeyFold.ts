/**
 * Redis 键名折叠（P7 S3）。
 *
 * 按 key 分隔符（缺省 `:`）把扁平 key 列表折叠成文件夹树。纯函数、无 IO，
 * 便于单测；主机侧在 SCAN 累积后调用，webview 只渲染结果。
 */

export interface RedisKeyFolder {
  /** 本层段名。 */
  name: string;
  /** 完整前缀路径（用分隔符连接的段名），根为 ''。 */
  path: string;
  /** 本文件夹（含所有子文件夹）下的 key 总数。 */
  count: number;
  folders: RedisKeyFolder[];
  /** 直接挂在本文件夹下的完整 key。 */
  keys: string[];
}

function emptyFolder(name: string, path: string): RedisKeyFolder {
  return { name, path, count: 0, folders: [], keys: [] };
}

/**
 * 折叠 keys。规则：
 *  - 无分隔符 / 分隔符为空 / 单段 key → 作为根的直接叶子；
 *  - 其余按分隔符切段，最后一段为叶（保留完整 key），前面各段为文件夹；
 *  - 去重；文件夹与叶子按名升序排序；count 为递归 key 数。
 */
export function foldRedisKeys(keys: readonly string[], separator = ':'): RedisKeyFolder {
  const root = emptyFolder('', '');
  const folders = new Map<string, RedisKeyFolder>();
  const seen = new Set<string>();

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const segments = separator ? key.split(separator) : [key];
    if (segments.length <= 1) {
      root.keys.push(key);
      continue;
    }
    let parent = root;
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix ? `${prefix}${separator}${segments[i]}` : segments[i];
      let folder = folders.get(prefix);
      if (!folder) {
        folder = emptyFolder(segments[i], prefix);
        folders.set(prefix, folder);
        parent.folders.push(folder);
      }
      parent = folder;
    }
    parent.keys.push(key);
  }

  const finalize = (folder: RedisKeyFolder): number => {
    let count = folder.keys.length;
    for (const child of folder.folders) count += finalize(child);
    folder.count = count;
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.keys.sort();
    return count;
  };
  finalize(root);
  return root;
}

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
