import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const PKG = join(__dirname, '../../package.json');
const SRC = join(__dirname, '../../src');

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return collectTsFiles(p);
    return name.endsWith('.ts') ? [p] : [];
  });
}

describe('命令注册完整性（§9 P0：命令到 handler 自动核查）', () => {
  it('package.json 每条 contributes.commands 均有注册调用点', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    const declared = (pkg.contributes.commands ?? []).map((c) => c.command);

    const registered = new Set<string>();
    // 注册调用点：sub('dbclient.x') / vscode.commands.registerCommand('dbclient.x')；
    // 覆盖 commands/*、org.ts 的局部 sub、account.ts 的 sub 与 extension.ts 直注册。
    for (const f of collectTsFiles(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:sub|registerCommand)\('(dbclient\.[A-Za-z.]+)'/g)) {
        registered.add(m[1]);
      }
    }

    const missing = declared.filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });
});