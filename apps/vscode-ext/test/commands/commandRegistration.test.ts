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

function readSrcText(): string {
  return collectTsFiles(SRC).map((f) => readFileSync(f, 'utf8')).join('\n');
}

describe('命令/视图注册完整性（§9 P0：命令到 handler 自动核查）', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
    contributes: {
      commands: { command: string }[];
      views: Record<string, { id: string }[]>;
      menus: Record<string, { command?: string }[]>;
    };
  };
  const src = readSrcText();
  const declared = new Set((pkg.contributes.commands ?? []).map((c) => c.command));

  it('每条 contributes.commands 均有注册调用点（sub/registerCommand，三种引号）', () => {
    const registered = new Set<string>();
    for (const m of src.matchAll(/(?:sub|registerCommand)\(\s*(['"`])(devbelt\.[A-Za-z0-9.]+)\1/g)) {
      registered.add(m[2]);
    }
    const missing = [...declared].filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it('每条 contributes.views 均有 createTreeView/registerWebviewViewProvider 调用点', () => {
    const views = Object.values(pkg.contributes.views ?? {}).flat() as { id: string }[];
    const created = new Set<string>();
    for (const m of src.matchAll(/(?:createTreeView|registerWebviewViewProvider)\(\s*(['"`])([A-Za-z0-9.-]+)\1/g)) {
      created.add(m[2]);
    }
    const missing = views.map((v) => v.id).filter((id) => !created.has(id));
    expect(missing).toEqual([]);
  });

  it('每条菜单引用的 command 均在声明集合中', () => {
    const referenced = new Set<string>();
    for (const entries of Object.values(pkg.contributes.menus ?? {})) {
      for (const entry of entries) {
        if (entry.command) referenced.add(entry.command);
      }
    }
    const unknown = [...referenced].filter((c) => !declared.has(c));
    expect(unknown).toEqual([]);
  });
});