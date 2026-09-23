import { describe, expect, it } from 'vitest';
import { en, zh } from '../../src/i18n/catalog';

/**
 * 词条数据的结构性约束。
 *
 * catalog 被扩展主进程与 webview 共用，键集漂移的表现是「某端某处显示键名」，
 * 运行时不报错，靠人眼很难发现，所以在这里机械把关。
 */
describe('i18n catalog', () => {
  const enKeys = Object.keys(en);
  const zhKeys = Object.keys(zh);

  it('中英键集完全一致', () => {
    const missingZh = enKeys.filter((k) => !(k in zh));
    const missingEn = zhKeys.filter((k) => !(k in en));
    expect(missingZh, `zh 缺少: ${missingZh.join(', ')}`).toEqual([]);
    expect(missingEn, `en 缺少: ${missingEn.join(', ')}`).toEqual([]);
  });

  it('两侧条数相同且非空', () => {
    expect(enKeys.length).toBe(zhKeys.length);
    expect(enKeys.length).toBeGreaterThan(200);
  });

  it('无空值或纯空白词条', () => {
    for (const [catalogName, catalog] of [['en', en], ['zh', zh]] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(typeof value, `${catalogName}.${key} 类型`).toBe('string');
        expect(value.trim(), `${catalogName}.${key} 为空`).not.toBe('');
      }
    }
  });

  it('占位符在中英之间一致（漏写会导致变量不被替换）', () => {
    const placeholders = (text: string): string[] =>
      (text.match(/\{(\w+)\}/g) ?? []).sort();

    for (const key of enKeys) {
      expect(placeholders(zh[key]), `键 ${key} 的占位符不一致`).toEqual(placeholders(en[key]));
    }
  });

  it('无重复键（对象字面量里重复键会静默覆盖）', async () => {
    // `Object.keys` 天然去重，看不出源文件里的重复键，必须扫描源文本逐键计数。
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    for (const [file, exported] of [['catalog.en.ts', enKeys], ['catalog.zh.ts', zhKeys]] as const) {
      const text = readFileSync(path.resolve(__dirname, '../../src/i18n', file), 'utf8');
      const counts = new Map<string, number>();
      for (const m of text.matchAll(/^\s*'([^']+)'\s*:/gm)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      const dupes = [...counts].filter(([, c]) => c > 1).map(([k]) => k);
      expect(dupes, `${file} 重复键`).toEqual([]);
      // 扫描到的键数应与导出对象一致（防止正则漏配而让上面的检查空转）
      expect(counts.size, `${file} 扫描键数`).toBe(exported.length);
    }
  });

  it('zh 词条确实是中文（防止漏翻直接复制英文）', () => {
    // 少数词条本身就是英文专有名词（SQL / DDL / ER 等），只要求整体中文占比达标
    const hasCjk = zhKeys.filter((k) => /[\u4e00-\u9fa5]/.test(zh[k]));
    expect(hasCjk.length / zhKeys.length).toBeGreaterThan(0.8);
  });

  it('webview 命名空间（wv.）两端同样成对', () => {
    const wvEn = enKeys.filter((k) => k.startsWith('wv.'));
    const wvZh = zhKeys.filter((k) => k.startsWith('wv.'));
    expect(wvEn.sort()).toEqual(wvZh.sort());
  });
});

/**
 * 代码引用的键必须存在。
 *
 * 回退链 `catalog[key] || en[key] || key` 会把缺失键原样显示（如
 * `foo.bar.baz`），运行时不报错。此前就有键这么漏出来。
 */
describe('i18n 键引用完整性', () => {
  it('src 中所有 l10n(\'...\') 的键都在 catalog 中', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !/catalog\.(en|zh)\.ts$/.test(p)) files.push(p);
      }
    };
    walk(root);

    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/l10n\(\s*'([^']+)'/g)) {
        if (!(m[1] in en)) missing.push(`${m[1]} (${path.relative(root, file)})`);
      }
    }
    expect(missing, `缺失键：${missing.join(', ')}`).toEqual([]);
  });
});
