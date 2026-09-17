const assert = require('assert');
const vscode = require('vscode');

/**
 * VSIX 安装 smoke 的扩展宿主断言（由 @vscode/test-electron 在**真实 VS Code** 中运行）。
 *
 * 前置由 scripts/vsix-smoke.mjs 完成：真实 `vsce package` 出 vsix → 安装到临时
 * extensions 目录 → 启动 VS Code。本文件只断言「安装后的 vsix 能被解析并激活」，
 * 不触碰数据库连接/同步（无需凭据）。
 */
const EXT_ID = 'lang2hong.devbelt';
const EXPECTED_COMMANDS = [
  'dbclient.openConnection',
  'dbclient.newQuery',
  'dbclient.designTable',
];

async function run() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found after vsix install (manifest id mismatch or not packaged)`);
  await ext.activate();
  assert.strictEqual(ext.isActive, true, 'extension failed to activate');
  const cmds = await vscode.commands.getCommands(true);
  for (const id of EXPECTED_COMMANDS) {
    assert.ok(cmds.includes(id), `command not registered after activation: ${id}`);
  }
}

module.exports = { run };