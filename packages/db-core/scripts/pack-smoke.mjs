/**
 * db-core 发布边界 smoke。
 *
 * 验证两件事，避免「本地 import 通过、发布后外部消费者解析失败」：
 *  1. `npm pack` 的 allowlist（files）/`exports` 映射指向的文件确实被打包；
 *  2. Node 原生 ESM 能按 `exports` 解析 `.` / `./sql` / `./testing`。
 *
 * 前置：先 `pnpm -C packages/db-core build`（产物在 dist/）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, encoding: 'utf8' });
const [info] = JSON.parse(raw);
const packaged = new Set((info.files ?? []).map((f) => f.path));

const targets = [];
for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
  const conditions = typeof value === 'string' ? { default: value } : value;
  for (const [condition, file] of Object.entries(conditions)) {
    targets.push([`${subpath} (${condition})`, String(file).replace(/^\.\//, '')]);
  }
}

const missing = targets.filter(([, file]) => !packaged.has(file));
if (missing.length > 0) {
  console.error('pack smoke: exports target missing from tarball:');
  for (const [label, file] of missing) console.error(`  - ${label} -> ${file}`);
  process.exit(1);
}

// 自引用 import：Node 依据 package.json 的 exports 解析这些说明符。
for (const specifier of ['@db-client/core', '@db-client/core/sql', '@db-client/core/testing']) {
  await import(specifier);
}

console.log(`pack smoke OK (${packaged.size} files packaged, ${targets.length} export targets, 3 subpaths resolvable)`);