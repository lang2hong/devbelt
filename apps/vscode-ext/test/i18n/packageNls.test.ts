import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const pkgText = readFileSync(join(ROOT, 'package.json'), 'utf8');
const en = JSON.parse(readFileSync(join(ROOT, 'package.nls.json'), 'utf8')) as Record<string, string>;
const zh = JSON.parse(readFileSync(join(ROOT, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;

/** 收集 package.json 文本中所有 `%key%` 占位符。 */
function collectPlaceholders(text: string): Set<string> {
  return new Set([...text.matchAll(/%([A-Za-z0-9_.-]+)%/g)].map((m) => m[1]));
}

describe('package.nls 契约（命令标题 %ref% 必须可解析）', () => {
  const used = collectPlaceholders(pkgText);

  it('package.json 里每个 %key% 在 en/zh 均有定义', () => {
    expect([...used].filter((k) => !(k in en))).toEqual([]);
    expect([...used].filter((k) => !(k in zh))).toEqual([]);
  });

  it('en/zh 键集合完全一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it('无死键：每个 nls 键都被 package.json 引用', () => {
    expect(Object.keys(en).filter((k) => !used.has(k))).toEqual([]);
  });
});