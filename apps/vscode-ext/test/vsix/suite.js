const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * VSIX 安装 smoke 的扩展宿主断言（由 @vscode/test-electron 在**真实 VS Code** 中运行）。
 *
 * 前置由 scripts/vsix-smoke.mjs 完成：真实 `vsce package` 出 vsix → 安装到临时
 * extensions 目录 → 启动 VS Code。本文件只断言「安装后的 vsix 能被解析并激活」，
 * 不触碰数据库连接/同步（无需凭据）。
 */
const EXT_ID = 'lang2hong.devbelt-db-client';
const EXPECTED_COMMANDS = [
  'devbelt.openConnection',
  'devbelt.newQuery',
  'devbelt.designTable',
  // 本阶段新增/关键的编辑器与结果命令：确认安装后仍注册（防止注册表回归）。
  'devbelt.runQuery',
  'devbelt.runAllQueries',
  'devbelt.formatSql',
  'devbelt.explainQuery',
  // 0.2.0 (P10 Insight)
  'devbelt.slowQueries',
  'devbelt.generateDictionary',
  // 0.4.2: sync diagnosability. These three are contributed unconditionally in
  // package.json, so a missing registration is a real regression, not a
  // signed-out state artifact.
  'devbelt.showDiagnostics',
  'devbelt.syncDoctor',
  'devbelt.toggleAutoSync',
];

/** Lazily loaded webview chunks that must ship in the vsix. */
const EXPECTED_WEBVIEW_CHUNKS = ['ExplainView.js', 'SlowQueryView.js'];

async function run() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found after vsix install (manifest id mismatch or not packaged)`);
  await ext.activate();
  assert.strictEqual(ext.isActive, true, 'extension failed to activate');

  // 打包后 webview 资源必须存在：`.vscodeignore` 误排除 out/webview/** 时这里直接报红
  //（此前只断言激活/命令，漏文件不会被发现）。
  const webviewEntry = path.join(ext.extensionPath, 'out', 'webview', 'index.js');
  assert.ok(fs.existsSync(webviewEntry), `packaged vsix is missing out/webview/index.js (${webviewEntry})`);

  for (const chunk of EXPECTED_WEBVIEW_CHUNKS) {
    const file = path.join(ext.extensionPath, 'out', 'webview', 'chunks', chunk);
    assert.ok(fs.existsSync(file), `packaged vsix is missing out/webview/chunks/${chunk}`);
  }

  const cmds = await vscode.commands.getCommands(true);
  for (const id of EXPECTED_COMMANDS) {
    assert.ok(cmds.includes(id), `command not registered after activation: ${id}`);
  }
}

module.exports = { run };