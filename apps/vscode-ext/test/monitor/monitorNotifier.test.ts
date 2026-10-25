import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => (_k === 'language' ? 'zh' : d) }) },
  env: { language: 'zh-cn' },
  window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined },
}));

import { describeCondition, describeTaskCondition, hitMessage, taskTitle } from '../../src/monitor/monitorNotifier';
import { lastResultText } from '../../src/monitor/monitorCommands';
import type { MonitorTask } from '../../src/monitor/monitorTypes';

function task(over: Partial<MonitorTask> = {}): MonitorTask {
  return {
    id: 'm1', kind: 'rowCount', connId: 'c1', database: 'app', table: 'orders', intervalMs: 60_000,
    condition: { type: 'anyChange' }, status: 'running', createdAt: 0, consecutiveFailures: 0, ...over,
  };
}

describe('per-kind monitor text', () => {
  it('row count: value in rows with the delta', () => {
    const msg = hitMessage(task(), 10, 12);
    expect(msg).toContain('行数 12');
    expect(msg).toContain('+2');
  });

  it('metric: names the watched column instead of “rows”', () => {
    const t = task({ kind: 'metric', watchColumn: 'lag_seconds', condition: { type: 'above', value: 600 } });
    const msg = hitMessage(t, 30, 34165);
    expect(msg).toContain('lag_seconds = 34,165');
    expect(msg).not.toContain('行数');
    expect(describeTaskCondition(t)).toMatch(/^lag_seconds: /);
  });

  it('new rows: count of this check, no delta against the previous check', () => {
    const t = task({ kind: 'newRows', cursorColumn: 'id', condition: { type: 'increaseBy', value: 10 } });
    const msg = hitMessage(t, 3, 12);
    expect(msg).toContain('新增 12 行');
    expect(msg).not.toContain('+9');
    expect(describeCondition(t.condition, 'newRows')).toContain('本次新增 ≥ 10 行');
  });

  it('title prefers the AI label, otherwise db.schema.table', () => {
    expect(taskTitle(task({ label: 'lc_data_event 新鲜度' }))).toBe('lc_data_event 新鲜度');
    expect(taskTitle(task({ schema: 'public' }))).toBe('app.public.orders');
    expect(hitMessage(task({ label: '订单量' }), undefined, 5)).toMatch(/^订单量/);
  });

  it('last result line per kind', () => {
    expect(lastResultText(task({ lastValue: 7 }), '10:00')).toContain('7 行');
    expect(lastResultText(task({ kind: 'metric', watchColumn: 'lag', lastValue: 7 }), '10:00')).toContain('lag');
    expect(lastResultText(task({ kind: 'newRows', lastValue: 7 }), '10:00')).toContain('新增 7');
    expect(lastResultText(task({ lastError: 'timeout' }), '10:00')).toContain('timeout');
  });
});
