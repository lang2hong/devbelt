import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 结果网格的可访问性/空状态契约。
 *
 * Webview 组件没有挂载测试环境（node + 源码扫描是本仓库的既有模式），
 * 这里锁定几个容易回退的语义：空状态、toast live region、确认弹窗的
 * dialog 语义与 Esc 关闭。
 */
const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

describe('结果网格 UX 语义', () => {
  const grid = read('../../webview/src/components/ResultGrid.vue');
  const dialog = read('../../webview/src/components/ConfirmDialog.vue');
  const codeBlock = read('../../webview/src/components/ai/CodeBlock.vue');

  it('0 行时显示空状态', () => {
    expect(grid).toContain("t('wv.grid.noRows')");
    expect(grid).toContain('class="empty-row"');
  });

  it('toast 使用 role=status 与 aria-live', () => {
    expect(grid).toMatch(/role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/);
  });

  it('删除确认改用具备 dialog 语义的 ConfirmDialog', () => {
    expect(grid).toContain('ConfirmDialog');
    expect(grid).not.toContain('class="modal-mask"');
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("e.key === 'Escape'");
  });

  it('筛选条件删除按钮有可访问名称', () => {
    expect(grid).toMatch(/:aria-label="t\('wv\.common\.delete'\)"[^>]*>✕</);
  });

  it('长代码块在内部滚动，不撑高对话', () => {
    expect(codeBlock).toMatch(/max-height:\s*\d+px/);
    expect(codeBlock).toMatch(/overflow:\s*auto/);
  });
});