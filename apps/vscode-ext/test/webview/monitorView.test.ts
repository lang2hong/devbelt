import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatMonitorTime, historySeries, proposalFailureText } from '../../webview/src/utils/monitorView';
import type { MonitorDetail } from '../../src/monitor/monitorBridge';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

function detail(over: Partial<MonitorDetail['task']>, points: MonitorDetail['points']): MonitorDetail {
  return {
    task: { id: 'm1', kind: 'rowCount', label: 't', connName: 'c', table: 't', status: 'running', intervalMs: 60_000, conditionText: '', ...over },
    points,
  };
}

describe('monitor view helpers', () => {
  const now = new Date(2026, 9, 25, 12, 0, 0).getTime();

  it('formats today as time only and other days with the date', () => {
    expect(formatMonitorTime(new Date(2026, 9, 25, 9, 5, 7).getTime(), now)).toBe('09:05:07');
    expect(formatMonitorTime(new Date(2026, 9, 24, 23, 0, 0).getTime(), now)).toBe('10-24 23:00:00');
  });

  it('builds one series per metric column and keeps NULLs out of the chart', () => {
    const d = detail({ kind: 'metric', columns: ['lag', 'n'] }, [
      { at: now - 120_000, values: { lag: 10, n: 1 }, durationMs: 3 },
      { at: now - 60_000, values: { lag: null, n: 2 }, durationMs: 4 },
      { at: now - 30_000, durationMs: 0, skipped: true },
      { at: now, durationMs: 5, error: 'timeout' },
    ]);
    const h = historySeries(d, now);
    expect(h.series).toEqual([{ label: 'lag', values: [10, 10] }, { label: 'n', values: [1, 2] }]);
    expect(h.rows.map((r) => [r.cells.lag, r.error])).toEqual([[ '—', 'timeout'], ['NULL', undefined], ['10', undefined]]);
  });

  it('uses a single row-count or new-rows series', () => {
    expect(historySeries(detail({}, [{ at: now, value: 74, durationMs: 1 }]), now).columns).toEqual(['rows']);
    expect(historySeries(detail({ kind: 'newRows' }, [{ at: now, value: 2, durationMs: 1 }]), now).columns).toEqual(['new_rows']);
  });
});

describe('monitor UI contracts', () => {
  const card = read('../../webview/src/components/ai/MonitorProposalCard.vue');
  const panel = read('../../webview/src/components/ai/MonitorPanel.vue');
  const view = read('../../webview/src/views/AIChatView.vue');

  it('creates a task only through the explicit confirm button', () => {
    expect(card).toContain("emit('confirm', p.id, interval)");
    expect(card).not.toMatch(/<textarea|contenteditable/);
    expect(view).toContain("post({ type: 'monitorConfirm', proposalId, intervalMinutes })");
    expect(view.match(/type: 'monitorConfirm'/g)).toHaveLength(1);
  });

  it('shows warnings and the current values on the proposal card', () => {
    expect(card).toContain('monitor.warning.');
    expect(card).toContain('p.preview');
  });

  it('only sends new-row contents to the AI when the user ticks the box', () => {
    expect(panel).toContain('v-model="includeRows"');
    expect(panel).toMatch(/const includeRows = ref\(false\)/);
    expect(panel).toContain("emit('explain', selected.id, includeRows)");
  });

  it('opens the background tasks drawer from the More menu', () => {
    expect(view).toContain("id: 'monitor'");
    expect(view).toContain('<MonitorPanel');
  });
});

describe('proposalFailureText', () => {
  const dict: Record<string, string> = {
    'monitor.reject.otherWindow': 'other window',
    'monitor.issue.trialFailed': 'trial failed: {detail}',
    'monitor.issue.columnMissing': 'no column {detail}',
  };
  const t = (key: string, vars?: Record<string, string | number>): string => {
    let text = dict[key] ?? key;
    for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, String(v));
    return text;
  };

  it('maps reasons and issues to readable text instead of codes', () => {
    expect(proposalFailureText(t, 'otherWindow', [])).toBe('other window');
    expect(proposalFailureText(t, 'validation', [{ code: 'trialFailed', detail: 'timeout' }, { code: 'columnMissing', detail: 'x' }]))
      .toBe('trial failed: timeout no column x');
  });

  it('falls back to the code when no text exists', () => {
    expect(proposalFailureText(t, 'weird', [{ code: 'odd', detail: 'd' }, 'bare'])).toBe('weird odd: d bare');
    expect(proposalFailureText(t, undefined, undefined)).toBe('');
  });
});
