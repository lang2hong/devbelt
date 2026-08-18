import type { ITrafficRepo, TrafficStatRow } from '../repository/interfaces.js';
import type { TrafficCollector } from './trafficCollector.js';

/** 按路由汇总的一行（表格用） */
export interface RouteSummary {
  route: string;
  total: number;
  ok: number;
  clientError: number;
  serverError: number;
  /** 4xx+5xx 占比，0..1，已四舍五入到 4 位小数 */
  errorRate: number;
}

/** 小时序列的一个点 */
export interface HourPoint {
  bucketTime: string;
  total: number;
  byClass: Record<number, number>;
}

/** 分钟序列的一个点（来自内存环形缓冲） */
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
  /** 区间内总请求数 */
  total: number;
  routes: RouteSummary[];
  hourly: HourPoint[];
  /** 最近 60 分钟，实时曲线用 */
  minutes: MinutePoint[];
  blocked: BlockedSummary[];
  blockedTotal: number;
}

/**
 * 流量报表聚合。
 *
 * 聚合刻意放在服务端而不是前端：admin-ui 目前没有测试运行器（无 vitest、
 * 无 test 脚本），装一套是独立的依赖变更。把逻辑放在这里，它就落在
 * 有 vitest 的包里，Vue 组件退化成纯 `v-for` 渲染。
 *
 * 这不是「为了架构纯洁」，是为了这段逻辑能被测到 —— 错误率计算、跨小时
 * 补零这类东西出错时前端只是画错一根线，很难被发现。
 */
export class TrafficReporter {
  constructor(
    private readonly repo: ITrafficRepo | undefined,
    private readonly collector: TrafficCollector,
  ) {}

  async report(hours: number, now: Date = new Date()): Promise<TrafficReport> {
    const to = now;
    // 小时桶按整点对齐，起点要往前推到整点，否则会漏掉当前小时的前半段
    const fromMs = Math.floor((now.getTime() - hours * 3_600_000) / 3_600_000) * 3_600_000;
    const from = new Date(fromMs);

    let rows: TrafficStatRow[] = [];
    let blocked: BlockedSummary[] = [];
    if (this.repo) {
      rows = await this.repo.queryStats(from, to);
      const b = await this.repo.queryBlocked(from, to, 200);
      blocked = b.map((r) => ({
        ip: r.ip,
        route: r.route,
        bucket: r.bucket,
        createTime: r.createTime.toISOString(),
      }));
    }

    return {
      hours,
      total: rows.reduce((s, r) => s + r.count, 0),
      routes: summarizeRoutes(rows),
      hourly: buildHourly(rows, from, to),
      minutes: this.collector.recentMinutes(now).map((m) => ({
        minuteTs: m.minuteTs,
        total: m.total,
        byClass: m.byClass,
      })),
      blocked,
      blockedTotal: blocked.length,
    };
  }
}

/** 按 route 汇总，按总量降序 —— 排最前的就是最该关注的 */
function summarizeRoutes(rows: TrafficStatRow[]): RouteSummary[] {
  const byRoute = new Map<string, RouteSummary>();
  for (const r of rows) {
    let s = byRoute.get(r.route);
    if (!s) {
      s = { route: r.route, total: 0, ok: 0, clientError: 0, serverError: 0, errorRate: 0 };
      byRoute.set(r.route, s);
    }
    s.total += r.count;
    if (r.statusClass === 2 || r.statusClass === 3) s.ok += r.count;
    else if (r.statusClass === 4) s.clientError += r.count;
    else if (r.statusClass === 5) s.serverError += r.count;
  }
  const out = [...byRoute.values()];
  for (const s of out) {
    s.errorRate =
      s.total === 0 ? 0 : Math.round(((s.clientError + s.serverError) / s.total) * 10_000) / 10_000;
  }
  return out.sort((a, b) => b.total - a.total);
}

/**
 * 小时序列，缺失的小时补零。
 *
 * 补零的理由和分钟环一样：前端画图时「零请求」和「无数据」必须一致，
 * 否则夜间空闲时段会画成断线，看起来像服务挂了。
 */
function buildHourly(rows: TrafficStatRow[], from: Date, to: Date): HourPoint[] {
  const byHour = new Map<number, HourPoint>();
  for (const r of rows) {
    const ts = Math.floor(r.bucketTime.getTime() / 3_600_000) * 3_600_000;
    let p = byHour.get(ts);
    if (!p) {
      p = { bucketTime: new Date(ts).toISOString(), total: 0, byClass: {} };
      byHour.set(ts, p);
    }
    p.total += r.count;
    p.byClass[r.statusClass] = (p.byClass[r.statusClass] ?? 0) + r.count;
  }

  const out: HourPoint[] = [];
  const startTs = Math.floor(from.getTime() / 3_600_000) * 3_600_000;
  const endTs = Math.floor(to.getTime() / 3_600_000) * 3_600_000;
  for (let ts = startTs; ts <= endTs; ts += 3_600_000) {
    out.push(byHour.get(ts) ?? { bucketTime: new Date(ts).toISOString(), total: 0, byClass: {} });
  }
  return out;
}
