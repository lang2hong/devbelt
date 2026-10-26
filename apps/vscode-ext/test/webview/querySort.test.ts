import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 结果表格列头排序的契约（源码扫描）：每个字段列头都有排序图标，
 * 升序 / 降序 / 取消三态循环，且带 aria-sort。
 */
const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const grid = read('../../webview/src/components/ResultGrid.vue');
const view = read('../../webview/src/views/QueryView.vue');

describe('结果表格列头排序', () => {
  it('列头始终显示排序图标，并标出当前方向', () => {
    expect(grid).toContain('class="sort-icon"');
    expect(grid).toContain("return sortDir === 'DESC' ? '▼' : '▲';");
    expect(grid).toContain("if (sortCol !== name) return '⇅';");
    expect(grid).toContain(':aria-sort="sortCol === f.name');
  });

  it('任意结果集支持升序 / 降序 / 取消三态', () => {
    expect(view).toContain("else if (sortDir.value === 'ASC') sortDir.value = 'DESC';");
    expect(view).toContain("else { sortCol.value = ''; sortDir.value = ''; }");
  });
});