import type { TrafficCollector } from './trafficCollector.js';

export interface RouteSummary {
  route: string;
  total: number;
  ok: number;
  clientError: number;
  serverError: number;
  errorRate: number;
}

export interface MinutePoint {
  minuteTs: number;
  total: number;
  byClass: Record<number, number>;
}

export interface BlockedSummary {
  ip: string;
  route: string;
  bucket: string;
  createTime: string;
}

export interface TrafficReport {
  hours: number;
  total: number;
  routes: RouteSummary[];
  hourly: MinutePoint[];
  minutes: MinutePoint[];
  blocked: BlockedSummary[];
  blockedTotal: number;
}

/**
 * 流量报表聚合（纯内存）。
 * v2：不再查 trafficRepo，全部从 collector 内存读。
 */
export class TrafficReporter {
  constructor(private readonly collector: TrafficCollector) {}

  report(hours: number, now: Date = new Date()): TrafficReport {
    const minutes = this.collector.recentMinutes(now).map((m) => ({
      minuteTs: m.minuteTs,
      total: m.total,
      byClass: m.byClass,
    }));
    const blocked = this.collector.recentBlocked(200).map((b) => ({
      ip: b.ip,
      route: b.route,
      bucket: b.bucket,
      createTime: b.createTime.toISOString(),
    }));
    return {
      hours,
      total: minutes.reduce((s, m) => s + m.total, 0),
      routes: summarizeRoutes(minutes),
      hourly: minutes,
      minutes,
      blocked,
      blockedTotal: blocked.length,
    };
  }
}

function summarizeRoutes(minutes: { total: number; byClass: Record<number, number> }[]): RouteSummary[] {
  // 按 route 汇总 —— 但内存分钟切片没有 route 维度（只有 total/byClass）。
  // 完整 route 维度需要 onResponse 时按 route 记，当前内存形态只给总量级。
  // 这里返回单行 "all"，前端表格仍可显示总量与错误率。
  const total = minutes.reduce((s, m) => s + m.total, 0);
  const byClass: Record<number, number> = {};
  for (const m of minutes) for (const [c, n] of Object.entries(m.byClass)) byClass[+c] = (byClass[+c] ?? 0) + n;
  const ok = (byClass[2] ?? 0) + (byClass[3] ?? 0);
  const clientError = byClass[4] ?? 0;
  const serverError = byClass[5] ?? 0;
  return [{
    route: 'all',
    total,
    ok,
    clientError,
    serverError,
    errorRate: total === 0 ? 0 : Math.round(((clientError + serverError) / total) * 10_000) / 10_000,
  }];
}
