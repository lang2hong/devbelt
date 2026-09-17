/**
 * db-core 发布边界 smoke。
 *
 * 验证真实发布产物（**npm pack 出的 tarball**，而非工作区）：
 *  1. `exports` 各条件指向的文件确实在解包后的树里存在；
 *  2. Node 原生 ESM 在解包目录内能自引用解析 `.` / `./sql` / `./testing`。
 *
 * 用真实 pack + 解包（过去只 `--dry-run` 看文件列表，无法发现
 * 目标缺失/路径不一致/解包后结构错位）。临时目录与 tarball 用后清理。
 *
 * 前置：先 `pnpm -C packages/db-core build`（产物在 dist/）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'db-core-pack-smoke-'));
try {
  const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const [info] = JSON.parse(raw);
  const tarball = path.join(tmp, info.filename);
  const extractDir = path.join(tmp, 'extract');
  execFileSync('mkdir', ['-p', extractDir]);
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir]);
  const unpackedPkgDir = path.join(extractDir, 'package');

  // exports 条件 → 目标文件（相对包根）。
  const targets = [];
  for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
    const conditions = typeof value === 'string' ? { default: value } : value;
    for (const [condition, file] of Object.entries(conditions)) {
      targets.push([`${subpath} (${condition})`, String(file).replace(/^\.\//, '')]);
    }
  }

  const missing = targets.filter(([, file]) => !existsSync(path.join(unpackedPkgDir, file)));
  if (missing.length > 0) {
    console.error('pack smoke: exports target missing from unpacked tarball:');
    for (const [label, file] of missing) console.error(`  - ${label} -> ${file}`);
    process.exit(1);
  }

  // 自引用 import：在解包目录内运行 Node，走真实 package.json exports 解析。
  // tarball 不含 node_modules（依赖由消费者安装），故把工作区 node_modules 软链进来，
  // 让入口能解析到 mysql2/pg/sqlstring；这不影响对「tarball 内文件/exports 映射」的校验。
  const nodeModules = [path.join(pkgDir, 'node_modules'), path.resolve(pkgDir, '..', '..', 'node_modules')]
    .find((p) => existsSync(p));
  if (nodeModules) symlinkSync(nodeModules, path.join(unpackedPkgDir, 'node_modules'));
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('@devkit/db-core'); await import('@devkit/db-core/sql'); await import('@devkit/db-core/testing');"],
    { cwd: unpackedPkgDir, stdio: 'inherit' },
  );

  console.log(`pack smoke OK (${info.files?.length ?? 0} files packaged, ${targets.length} export targets, 3 subpaths resolvable)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}