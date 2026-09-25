import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { en } from '../../src/i18n/catalog';

const WEBVIEW_SRC = path.resolve(__dirname, '../../webview/src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(WEBVIEW_SRC);
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

/** 提取 `t('key')` 引用。前置断言排除 emit(/format( 这类以 t 结尾的调用。 */
function usedKeys(text: string): string[] {
  return [...text.matchAll(/(?<![\w$])t\('([\w.]+)'/g)].map((m) => m[1]);
}

/**
 * webview 文案迁移的守门测试。
 *
 * 迁移前 11 个视图硬编码英文、2 个视图各自内嵌 I18N 表。这里机械保证：
 * 引用的键都存在、不再出现新的硬编码文案、语言由统一入口驱动。
 */
describe('webview i18n 迁移完整性', () => {
  it('所有 t() 引用的键都在 catalog 中（否则界面显示键名）', () => {
    const missing: string[] = [];
    for (const [file, text] of sources) {
      for (const key of usedKeys(text)) {
        if (!(key in en)) missing.push(`${path.basename(file)}: ${key}`);
      }
    }
    expect(missing, `缺失词条:\n${missing.join('\n')}`).toEqual([]);
  });

  it('不再有内嵌 I18N 表（词条须集中在 catalog）', () => {
    const offenders = [...sources.entries()]
      .filter(([, text]) => /const I18N\s*:/.test(text))
      .map(([file]) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it('视图不自行维护 isZh 状态（语言由 App.vue 的 setLanguage 统一驱动）', () => {
    const offenders = [...sources.entries()]
      .filter(([file, text]) => !file.endsWith('useI18n.ts') && /const isZh = ref\(/.test(text))
      .map(([file]) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it('模板里没有残留的硬编码英文文案', () => {
    // 只查 >Word...< 形式的可见文本，跳过插值、单字母、纯数字/符号
    const pattern = />([A-Z][A-Za-z]+(?: [A-Za-z().]+){0,6})</g;
    const offenders: string[] = [];
    for (const [file, text] of sources) {
      const template = text.slice(text.indexOf('<template>'));
      for (const m of template.matchAll(pattern)) {
        const word = m[1].trim();
        // 产品名与技术缩写保留原文
        if (/^(MySQL|PostgreSQL|SQLite|Redis|SQL|DDL|JSON|CSV|XML|Excel|PNG|ER|X|Y)$/.test(word)) continue;
        offenders.push(`${path.basename(file)}: "${word}"`);
      }
    }
    expect(offenders, `残留硬编码文案:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('有文案的视图都引入了 useI18n', () => {
    const offenders: string[] = [];
    for (const [file, text] of sources) {
      if (usedKeys(text).length > 0 && !text.includes('useI18n')) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('App.vue 在切换 mode 前调用 setLanguage（保证首次渲染语言正确）', () => {
    const app = sources.get(path.join(WEBVIEW_SRC, 'App.vue'))!;
    const iSet = app.indexOf('setLanguage(');
    const iMode = app.indexOf('mode.value =');
    expect(iSet).toBeGreaterThan(-1);
    expect(iSet).toBeLessThan(iMode);
  });

  it('随语言变化的列表用 computed 而非模块级 const', () => {
    // 模块级 const 在 import 时求值，那时 setLanguage 尚未调用，文案会锁死英文
    const grid = sources.get(path.join(WEBVIEW_SRC, 'components', 'ResultGrid.vue'))!;
    expect(grid).toMatch(/const FILTER_OPS = computed\(/);
  });
});
