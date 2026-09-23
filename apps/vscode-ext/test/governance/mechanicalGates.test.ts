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
    const intentionalUndeclared = new Set(['devbelt.clearLocalSync']);
    const undeclared = [...registered].filter((c) => !declared.has(c) && !intentionalUndeclared.has(c));
    const unregistered = [...declared].filter((c) => !registered.has(c));
    expect(undeclared, `注册但未在 package.json 声明：${undeclared.join(', ')}`).toEqual([]);
    expect(unregistered, `声明但未注册：${unregistered.join(', ')}`).toEqual([]);
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