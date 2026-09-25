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
