import type { ChartSeries } from './chartInference';
import type { MonitorDetail } from '../../../src/monitor/monitorBridge';
import { formatInterval } from '../../../src/monitor/monitorTypes';

/** 时间点显示：今天只显示时分秒，其他日期带月日。 */
export function formatMonitorTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

export function formatIntervalText(ms: number, zh: { value: boolean } | boolean): string {
  return formatInterval(ms, typeof zh === 'boolean' ? zh : zh.value);
}

export interface HistoryTable {
  /** 图表 x 轴（时间）与序列（每列一条线 / 新增行数一组柱）。 */
  x: string[];
  series: ChartSeries[];
  /** 表格列（A1：行数；A2：各列；B：新增行数）。 */
  columns: string[];
  /** 表格行（最新在前）。 */
  rows: Array<{ time: string; cells: Record<string, string>; duration: string; error?: string }>;
}

const MAX_CHART_POINTS = 60;

/**
 * 提案创建失败的说明：原因 / 校验问题映射到词条（`monitor.reject.*`、`monitor.issue.*`），
 * 词条缺失时才退回显示代码，不把 `otherWindow` 这类内部代码直接给用户看。
 */
export function proposalFailureText(
  t: (key: string, vars?: Record<string, string | number>) => string,
  reason: unknown,
  issues: unknown,
): string {
  const parts: string[] = [];
  const list = Array.isArray(issues) ? issues : [];
  const code = typeof reason === 'string' ? reason : '';
  // 校验失败时只列具体问题；其他原因先说原因。
  if (code && (code !== 'validation' || list.length === 0)) {
    const text = t(`monitor.reject.${code}`);
    parts.push(text === `monitor.reject.${code}` ? code : text);
  }
  for (const raw of list) {
    const issue = typeof raw === 'string' ? { code: raw } : (raw as { code?: unknown; detail?: unknown });
    if (!issue || typeof issue.code !== 'string') continue;
    const detail = typeof issue.detail === 'string' ? issue.detail : '';
    const text = t(`monitor.issue.${issue.code}`, { detail });
    parts.push(text === `monitor.issue.${issue.code}` ? (detail ? `${issue.code}: ${detail}` : issue.code) : text);
  }
  return parts.join(' ');
}

/**
 * 历史点 → 图表序列 + 表格行。跳过（skipped）的点不画；失败点在表格里显示错误、图表里不画。
 * A2 的 NULL 在图里画成 0 会误导，因此跳过该列在这一点的值（用前一个值占位，表格显示 NULL）。
 */
export function historySeries(detail: MonitorDetail, now: number = Date.now()): HistoryTable {
  const task = detail.task;
  const points = detail.points.filter((p) => !p.skipped);
  const columns = task.kind === 'metric'
    ? (task.columns ?? Object.keys(points.find((p) => p.values)?.values ?? {}))
    : [task.kind === 'newRows' ? 'new_rows' : 'rows'];

  const ok = points.filter((p) => !p.error).slice(-MAX_CHART_POINTS);
  const x = ok.map((p) => formatMonitorTime(p.at, now));
  const series: ChartSeries[] = columns.map((col) => {
    let last = 0;
    return {
      label: col,
      values: ok.map((p) => {
        const raw = task.kind === 'metric' ? p.values?.[col] : p.value;
        if (typeof raw === 'number' && Number.isFinite(raw)) last = raw;
        return last;
      }),
    };
  });

  const rows = [...points].reverse().slice(0, 100).map((p) => {
    const cells: Record<string, string> = {};
    for (const col of columns) {
      const raw = task.kind === 'metric' ? p.values?.[col] : p.value;
      cells[col] = raw === null ? 'NULL' : typeof raw === 'number' ? raw.toLocaleString() : '—';
    }
    return {
      time: formatMonitorTime(p.at, now),
      cells,
      duration: `${p.durationMs} ms`,
      ...(p.error ? { error: p.error } : {}),
    };
  });
  return { x, series, columns, rows };
}
