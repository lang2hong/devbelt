import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');
const MODULES = ['auth', 'db', 'billing', 'admin'];

/**
 * 允许的跨模块依赖方向（值 = 可被该模块 import 的模块）。
 *
 * 现状记录（待收敛）：单体后端中少量服务仍跨模块直连（注册发权益、链接流读同步）。
 * 新增跨模块依赖必须先在此登记，避免边界无声腐化。
 */
const ALLOWED: Record<string, string[]> = {
  auth: ['billing', 'db'],
  billing: [],
  db: ['auth', 'billing'],
  admin: ['auth', 'db', 'billing'],
};

/** 组合根：允许 import 任意模块（装配各模块依赖）。 */
const COMPOSITION_ROOTS = ['app.ts', 'index.ts'];
const COMPOSITION_DIRS = ['bootstrap', 'scripts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 从文件内解析相对 import 指向的 src 绝对路径（去扩展名），仅返回 src 下 .ts。 */
function relativeImports(file: string, text: string): string[] {
  const out: string[] = [];
  const re = /from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = m[1] ?? m[2];
    let target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '');
    if (!target.startsWith(SRC)) continue;
    out.push(target);
  }
  return out;
}

function moduleOf(file: string): string | null {
  const rel = path.relative(SRC, file).split(path.sep);
  if (rel[0] === 'modules' && MODULES.includes(rel[1])) return rel[1];
  return null;
}

function isCompositionRoot(file: string): boolean {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  if (COMPOSITION_ROOTS.includes(rel)) return true;
  return COMPOSITION_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

describe('server module boundaries', () => {
  const files = walk(SRC);

  it('no cross-module import outside the allowed directions', () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = moduleOf(file);
      if (!from) continue;
      const text = readFileSync(file, 'utf8');
      for (const target of relativeImports(file, text)) {
        const to = moduleOf(target);
        if (!to || to === from) continue;
        if (!ALLOWED[from]?.includes(to)) {
          violations.push(`${path.relative(SRC, file)} -> modules/${to}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('shared code does not import module code (except composition roots)', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (moduleOf(file) || isCompositionRoot(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const target of relativeImports(file, text)) {
        const to = moduleOf(target);
        if (to) violations.push(`${path.relative(SRC, file)} -> modules/${to}`);
      }
    }
    expect(violations).toEqual([]);
  });
});