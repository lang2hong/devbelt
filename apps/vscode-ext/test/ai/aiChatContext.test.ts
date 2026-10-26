import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AI Chat 上下文契约（源码扫描）：长对话不再硬截断，而是「最近 8 条原文 + 模型滚动摘要」；
 * 监控类请求会自动开启 Agent，并提示用户。
 */
const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const view = read('../../src/result/aiChatView.ts');
const webview = read('../../webview/src/views/AIChatView.vue');

describe('历史压缩接线', () => {
  it('用滚动摘要替换「只留最后 20 条」', () => {
    expect(view).toContain('planHistory(all');
    expect(view).toContain('prepareHistory(session)');
    expect(view).toContain('summarizeHistory(summary, plan.pending)');
    expect(view).toContain('summaryBlock(history?.summary)');
    // 摘要失败退回确定性压缩，仍然推进覆盖点（避免每轮重试花额度）
    expect(view).toContain('plan.fallback');
    expect(view).toContain('session.summaryUpTo = nextCovered');
  });

  it('把最近用户消息作为表筛选关键词', () => {
    expect(view).toContain('buildContext(recentUserText)');
    expect(view).toContain('...(userText ? { userText } : {})');
  });

  it('监控意图自动开启 Agent 并提示', () => {
    expect(view).toContain('wantsMonitorTask(lastUserText)');
    expect(view).toContain("type: 'agentModeChanged', enabled: true");
    expect(view).toContain("type: 'agentNotice'");
    expect(webview).toContain("case 'agentNotice':");
  });
});