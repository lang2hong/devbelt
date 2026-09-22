import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SRC = resolve(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * 机械门禁：这些约束靠人眼很难守，且失守不报错，只表现为运行时行为退化。
 * 放进单测后本地与 CI 都会强制。
 */
describe('机械门禁', () => {
  it('禁止使用 vscode.l10n.t（无 l10n bundle → 恒英文，与项目 i18n 不一致）', () => {
    const offenders = walk(SRC)
      .filter((f) => /vscode\.l10n\.t\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(offenders, `改用 src/i18n 的 l10n(): ${offenders.join(', ')}`).toEqual([]);
  });

  it('package.json 声明的命令与源码注册的命令一一对应', () => {
    // 注册但未声明 → 无法从快捷键/命令面板/菜单引用（死命令）；声明但未注册 →
    // 点了报「command not found」。二者都靠人眼难守，这里机械校验。
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const declared = new Set<string>((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
    const registered = new Set<string>();
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/sub\(\s*.(devbelt[\w.]+)./g)) registered.add(m[1]);
      for (const m of text.matchAll(/registerCommand\(\s*.(devbelt[\w.]+)./g)) registered.add(m[1]);
    }
    // 有意不声明：历史别名，用户可能已绑快捷键，但不应进命令面板。
    const intentionalUndeclared = new Set([
      'devbelt.clearLocalSync',
      'devbelt.authenticator._smoketest', // S1 临时内部手测命令，S2 引入正式命令时删除
    ]);
    const undeclared = [...registered].filter((c) => !declared.has(c) && !intentionalUndeclared.has(c));
    const unregistered = [...declared].filter((c) => !registered.has(c));
    expect(undeclared, `注册但未在 package.json 声明：${undeclared.join(', ')}`).toEqual([]);
    expect(unregistered, `声明但未注册：${unregistered.join(', ')}`).toEqual([]);
  });

  it('节点专属组织命令不得出现在命令面板（调用时静默无反应）', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const nodeOnly = [
      'devbelt.org.deleteFolder',
      'devbelt.org.deleteResource',
      'devbelt.org.openResource',
      'devbelt.org.connectTemplate',
    ];
    const palette = new Map((pkg.contributes.menus.commandPalette as { command: string; when?: string }[])
      .map((e) => [e.command, e.when]));
    const visible = nodeOnly.filter((c) => palette.get(c) !== 'false');
    expect(visible, `这些命令需要树节点，命令面板应隐藏：${visible.join(', ')}`).toEqual([]);
  });

  /**
   * 派生自源码：凡是处理器签名要求 `node: DbTreeNode|OrgTreeNode` 的命令，都需要一个
   * 树节点才能工作；命令面板调用时 node 为 undefined，处理器只会静默 return，看起来
   * 就是「点了没反应」。这类命令必须在 commandPalette 里 `when:false`，只能从树上下文
   * 进入。新增节点命令若忘记隐藏，此测试会失败。
   */
  it('节点必需命令一律不在命令面板', () => {
    const tolerant = new Set(['devbelt.org.newQuery', 'devbelt.org.newFolder']);
    const commands = new Set<string>();
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/sub\(\s*.(devbelt[\w.]+).\s*,\s*async\s*\(\s*node\s*:\s*(?:DbTreeNode|OrgTreeNode)/g)) {
        commands.add(m[1]);
      }
    }
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const palette = new Map((pkg.contributes.menus.commandPalette as { command: string; when?: string }[])
      .map((e) => [e.command, e.when]));
    const visible = [...commands].filter((c) => !tolerant.has(c) && palette.get(c) !== 'false');
    expect(visible, `这些命令需要树节点，命令面板应 when:false：${visible.join(', ')}`).toEqual([]);
  });

  it('用户可见通知不得硬编码文案（必须走 l10n）', () => {
    const offenders = walk(SRC)
      .filter((f) => /show(?:Error|Warning|Information)Message\(\s*['"`]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(offenders, `改用 l10n()：${offenders.join(', ')}`).toEqual([]);
  });

  it('view/item/context 的 when 均含 viewItem 条件（防上下文键错配）', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const menus = pkg.contributes.menus['view/item/context'] as { command: string; when?: string }[];
    const missing = menus.filter((e) => !/viewItem/.test(e.when || '')).map((e) => e.command);
    expect(missing, `缺少 viewItem 条件：${missing.join(', ')}`).toEqual([]);
  });
});