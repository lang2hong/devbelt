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

  it('view/item/context 的 when 均含 viewItem 条件（防上下文键错配）', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const menus = pkg.contributes.menus['view/item/context'] as { command: string; when?: string }[];
    const missing = menus.filter((e) => !/viewItem/.test(e.when || '')).map((e) => e.command);
    expect(missing, `缺少 viewItem 条件：${missing.join(', ')}`).toEqual([]);
  });
});