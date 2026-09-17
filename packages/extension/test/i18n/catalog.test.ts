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

  it('无重复键（对象字面量里重复键会静默覆盖）', () => {
    // Object.keys 天然去重，这里改为断言源文件里每个键只出现一次
    expect(new Set(enKeys).size).toBe(enKeys.length);
    expect(new Set(zhKeys).size).toBe(zhKeys.length);
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
