/**
 * VSIX 安装 smoke：真实打包 → 真实安装 → 真实启动激活。
 *
 * 步骤：
 *  1. `vsce package --no-dependencies` 产出 vsix 到临时目录（不落仓库）；
 *  2. 用 @vscode/test-electron 下载 VS Code（默认 stable，可用
 *     VSIX_SMOKE_VSCODE_VERSION 覆盖）；
 *  3. 以临时 `--extensions-dir`/`--user-data-dir` **安装该 vsix**（走真实安装路径）；
 *  4. `runTests` 启动 VS Code 跑 test/vsix/suite.js 的激活断言；
 *  5. finally 清理临时目录。
 *
 * 前置：扩展已构建（`pnpm -C apps/vscode-ext build`，即 out/ 与 webview dist 就绪）。
 * Linux 无显示环境需 `xvfb-run -a`（CI 已如此）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  runTests,
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(path.join(pkgDir, 'out', 'extension.js'))) {
  console.error('vsix smoke: out/extension.js 不存在，请先执行 `pnpm -C apps/vscode-ext build`。');
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'vsix-smoke-'));
try {
  const vsix = path.join(tmp, 'ext.vsix');
  const vsceBin = path.join(pkgDir, 'node_modules', '.bin', 'vsce');
  const vsceCmd = existsSync(vsceBin) ? vsceBin : 'npx';
  const vsceArgs = existsSync(vsceBin)
    ? ['package', '--no-dependencies', '--out', vsix]
    : ['vsce', 'package', '--no-dependencies', '--out', vsix];
  execFileSync(vsceCmd, vsceArgs, { cwd: pkgDir, stdio: 'inherit' });

  const version = process.env.VSIX_SMOKE_VSCODE_VERSION ?? 'stable';
  const vscodeExecutablePath = await downloadAndUnzipVSCode(version);
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

  const extensionsDir = path.join(tmp, 'extensions');
  const userDataDir = path.join(tmp, 'user-data');
  // 真实安装路径（解包 + manifest 校验）；--force 覆盖同 id 旧版本。
  execFileSync(
    cli,
    [...cliArgs, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--install-extension', vsix, '--force'],
    { stdio: 'inherit' },
  );

  await runTests({
    vscodeExecutablePath,
    extensionTestsPath: path.join(pkgDir, 'test', 'vsix', 'suite.js'),
    // 不带 extensionDevelopmentPath：扩展来自安装好的 vsix，而非源码目录。
    // 不加 --disable-extensions，否则连被测扩展也会被禁用。
    launchArgs: ['--extensions-dir', extensionsDir, '--user-data-dir', userDataDir],
    extensionTestsEnv: { VSIX_SMOKE: '1' },
  });

  console.log('vsix smoke OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}