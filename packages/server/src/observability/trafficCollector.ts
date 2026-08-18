import type { TrafficStatRow } from '../repository/interfaces.js';

/** 一分钟的流量切片，按状态类归并 */
export interface MinuteSlice {
  /** 该分钟的起始毫秒时间戳 */
  minuteTs: number;
  /** 2xx / 3xx / 4xx / 5xx 各自的计数 */
  byClass: Record<number, number>;
  total: number;
}

export interface BlockedEntry {
  ip: string;
  route: string;
  bucket: string;
}

const RING_SIZE = 60;

/**
 * 流量采集器（纯内存，无 I/O，不依赖 Fastify）。
 *
 * 两层数据，用途不同：
 *
 * 1. **分钟环形缓冲（60 槽）** —— 「现在怎么样」。进程重启即丢，这是有意的：
 *    实时曲线的价值在于即时性，为它做持久化不值得。
 * 2. **小时桶** —— 「趋势如何」。攒够一批由 plugin 定时 flush 到 traffic_stats。
 *
 * 环形缓冲用 `minuteTs % 60` 作索引，槽被复用时自动重置 —— 不需要任何显式
 * 清理逻辑，也就不会有「清理任务没跑导致内存涨」的问题。
 *
 * 这个类刻意不知道数据库的存在：`drain()` 交出数据，谁来落库是 plugin 的事。
 * 这样单测不需要任何 mock。
 */
export class TrafficCollector {
  private readonly ring: Array<MinuteSlice | undefined> = new Array(RING_SIZE);
  /** 待 flush 的小时桶。key = `${hourTs}|${route}|${statusClass}` */
  private pending = new Map<string, TrafficStatRow>();
  private pendingBlocked: BlockedEntry[] = [];

  /**
   * 记一次请求。
   *
   * @param route 路由**模板**（`/admin/users/:id`），不是实际路径 ——
   *   实际路径基数无界，会把 traffic_stats 打爆
   * @param statusCode HTTP 状态码，内部折算成 statusClass
   */
  record(route: string, statusCode: number, at: Date = new Date()): void {
    const statusClass = Math.floor(statusCode / 100);
    const ms = at.getTime();

    // 分钟环
    const minuteTs = Math.floor(ms / 60_000) * 60_000;
    const idx = (minuteTs / 60_000) % RING_SIZE;
    const slot = this.ring[idx];
    if (!slot || slot.minuteTs !== minuteTs) {
      // 槽为空或属于 60 分钟前的同索引分钟 → 直接覆盖，旧数据自然淘汰
      this.ring[idx] = { minuteTs, byClass: { [statusClass]: 1 }, total: 1 };
    } else {
      slot.byClass[statusClass] = (slot.byClass[statusClass] ?? 0) + 1;
      slot.total++;
    }

    // 小时桶
    const hourTs = Math.floor(ms / 3_600_000) * 3_600_000;
    const key = `${hourTs}|${route}|${statusClass}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.count++;
    } else {
      this.pending.set(key, {
        bucketTime: new Date(hourTs),
        route,
        statusClass,
        count: 1,
      });
    }
  }

  /** 记一次被限流拦截。单独存是因为 statusClass=4 混了 400/401/403/404 */
  recordBlocked(entry: BlockedEntry): void {
    this.pendingBlocked.push(entry);
  }

  /**
   * 最近 60 分钟的切片，按时间升序，缺失的分钟补零。
   *
   * 补零很重要：前端画曲线时，「没有请求」和「没有数据」必须是同一回事，
   * 否则空闲时段会画出断线。
   */
  recentMinutes(now: Date = new Date()): MinuteSlice[] {
    const currentMinute = Math.floor(now.getTime() / 60_000) * 60_000;
    const out: MinuteSlice[] = [];
    for (let i = RING_SIZE - 1; i >= 0; i--) {
      const minuteTs = currentMinute - i * 60_000;
      const slot = this.ring[(minuteTs / 60_000) % RING_SIZE];
      out.push(
        slot && slot.minuteTs === minuteTs
          ? { minuteTs, byClass: { ...slot.byClass }, total: slot.total }
          : { minuteTs, byClass: {}, total: 0 },
      );
    }
    return out;
  }

  /** 取出并清空待 flush 的小时桶 */
  drain(): TrafficStatRow[] {
    if (this.pending.size === 0) return [];
    const rows = [...this.pending.values()];
    this.pending = new Map();
    return rows;
  }

  /** 取出并清空待 flush 的 429 记录 */
  drainBlocked(): BlockedEntry[] {
    if (this.pendingBlocked.length === 0) return [];
    const rows = this.pendingBlocked;
    this.pendingBlocked = [];
    return rows;
  }

  /**
   * flush 失败时把数据合并回待 flush 集合，下个周期重试。
   *
   * 必须是**合并**而不是覆盖：`drain()` 之后新请求已经在往 pending 里写了，
   * 直接赋值会把这段时间的数据丢掉。
   */
  restore(rows: TrafficStatRow[]): void {
    for (const r of rows) {
      const key = `${r.bucketTime.getTime()}|${r.route}|${r.statusClass}`;
      const existing = this.pending.get(key);
      if (existing) existing.count += r.count;
      else this.pending.set(key, { ...r });
    }
  }

  /** 同上，429 记录的回滚 */
  restoreBlocked(rows: BlockedEntry[]): void {
    // 放回队首，保持大致的时间顺序
    this.pendingBlocked = [...rows, ...this.pendingBlocked];
  }

  /** 当前待 flush 行数，供测试与诊断 */
  pendingSize(): number {
    return this.pending.size;
  }

  pendingBlockedSize(): number {
    return this.pendingBlocked.length;
  }
}
