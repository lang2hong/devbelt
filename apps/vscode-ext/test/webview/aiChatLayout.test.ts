import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isQuotaLow, LOW_QUOTA_RATIO } from '../../webview/src/utils/credits';

/**
 * AI Chat 简洁布局的契约（源码扫描，与 uxSemantics 同一模式：webview 没有挂载环境）。
 *
 * 锁定的是「默认简洁、需要时再展开」：顶栏一行、低频功能进「⋯」、
 * 侧栏改抽屉、统计收进悬停、代码块只直出两个按钮。
 */
const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const template = (src: string) => src.slice(src.indexOf('<template>'), src.lastIndexOf('</template>'));

const view = read('../../webview/src/views/AIChatView.vue');
const bar = read('../../webview/src/components/ai/ContextBar.vue');
const menu = read('../../webview/src/components/ai/MoreMenu.vue');
const drawer = read('../../webview/src/components/ai/SideDrawer.vue');
const quotaPanel = read('../../webview/src/components/ai/QuotaPanel.vue');
const input = read('../../webview/src/components/ai/ChatInput.vue');
const bubble = read('../../webview/src/components/ai/MessageBubble.vue');
const codeBlock = read('../../webview/src/components/ai/CodeBlock.vue');

describe('AI Chat 顶栏', () => {
  it('只有一行常规内容，不再显示 tokens / 表数摘要和额度进度条', () => {
    const tpl = template(bar);
    expect(tpl.match(/class="ai-context-row"/g)).toHaveLength(1);
    expect(bar).not.toContain('wv.ai.context.summary');
    expect(tpl).not.toContain('ai-quota-bar');
    expect(tpl).not.toContain('provider.model');
  });

  it('额度只在低额度时常驻，点击进入额度抽屉', () => {
    expect(bar).toMatch(/v-if="quotaLow"/);
    expect(bar).toContain("emit('openQuota')");
  });

  it('「实际注入的表」按钮紧跟库选择器，截断时标黄并提示', () => {
    const tpl = template(bar);
    const scopeAt = tpl.indexOf('showScopeSelect');
    const tablesAt = tpl.indexOf('ai-tables-badge');
    const spacerAt = tpl.indexOf('ai-spacer');
    expect(scopeAt).toBeGreaterThan(0);
    expect(tablesAt).toBeGreaterThan(scopeAt);
    expect(tablesAt).toBeLessThan(spacerAt);
    expect(bar).toContain(':class="{ truncated: tablesTruncated }"');
    expect(bar).toContain("t('wv.ai.tables.truncatedHint')");
    expect(bar).toContain("emit('openTables')");
    expect(view).toContain('@open-tables="openDrawer(\'tables\')"');
  });

  it('只在需要处理时显示提示条', () => {
    expect(bar).toMatch(/v-if="alert"/);
    expect(bar).toContain("'login-required'");
    expect(bar).toContain("'no-session'");
  });
});

describe('「⋯」更多菜单', () => {
  it('收纳会话、规则、额度、模型接入与设置；注入的表不在菜单里', () => {
    for (const id of ['sessions', 'rules', 'quota', 'modelAccess', 'settings']) {
      expect(view, id).toContain(`id: '${id}'`);
    }
    expect(view).not.toContain("id: 'tables'");
  });

  it('有菜单语义与键盘操作', () => {
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain('role="menu"');
    expect(menu).toContain('role="menuitem"');
    expect(menu).toContain("'Escape'");
    expect(menu).toContain("'ArrowDown'");
  });
});

describe('抽屉', () => {
  it('左侧常驻栏已移除，改为默认关闭的右侧抽屉', () => {
    expect(view).not.toContain('class="ai-side"');
    expect(view).toContain('<SideDrawer v-if="drawer"');
    expect(view).toMatch(/const drawer = ref<DrawerKind \| null>\(null\)/);
  });

  it('抽屉有 dialog 语义，Esc 与点遮罩关闭', () => {
    expect(drawer).toContain('role="dialog"');
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toContain("event.key === 'Escape'");
    expect(drawer).toContain('@mousedown.self="emit(\'close\')"');
  });

  it('额度抽屉能查明细、刷新与充值', () => {
    expect(quotaPanel).toContain('wv.ai.quota.remainingLabel');
    expect(quotaPanel).toContain('wv.ai.quota.usedLabel');
    expect(quotaPanel).toContain("emit('refresh')");
    expect(quotaPanel).toContain("emit('buy')");
  });
});

describe('输入区与消息', () => {
  it('Agent 是输入框下方的开关，不在工具栏', () => {
    expect(input).toContain('role="switch"');
    expect(input).toContain(':aria-checked');
    expect(view).not.toContain('wv.ai.agent.on');
    expect(view).not.toContain('class="ai-toolbar"');
  });

  it('回复统计收进悬停提示，不常驻', () => {
    const tpl = template(bubble);
    expect(tpl).not.toContain("t('wv.ai.msg.duration'");
    expect(bubble).toContain(':title="usageText"');
  });

  it('消息操作悬停或聚焦时出现，触屏常显', () => {
    expect(bubble).toMatch(/\.ai-bubble:hover \.ai-msg-actions,\s*\.ai-bubble:focus-within \.ai-msg-actions/);
    expect(bubble).toContain('@media (hover: none)');
  });

  it('代码块只直出「复制」「运行」，其余进代码块的「⋯」', () => {
    const actions = template(codeBlock).match(/<div class="ai-code-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(actions.match(/<button/g)).toHaveLength(2);
    expect(actions).toContain('<MoreMenu');
    expect(codeBlock).toContain("id: 'insert'");
    expect(codeBlock).toContain("id: 'runPanel'");
  });
});

describe('低额度判定', () => {
  it('剩余 ≤ 上限的 10% 或耗尽时为低额度', () => {
    expect(LOW_QUOTA_RATIO).toBe(0.1);
    expect(isQuotaLow({ limit: 100_000, remaining: 10_000 })).toBe(true);
    expect(isQuotaLow({ limit: 100_000, remaining: 10_001 })).toBe(false);
    expect(isQuotaLow({ limit: 100_000, remaining: 0 })).toBe(true);
    expect(isQuotaLow({ limit: 0, remaining: 0 })).toBe(true);
    expect(isQuotaLow({ limit: 0, remaining: 5 })).toBe(false);
    expect(isQuotaLow(null)).toBe(false);
  });
});
