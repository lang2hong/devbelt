/** 一分钟的流量切片，按状态类归并 */
export interface MinuteSlice {
  minuteTs: number;
  byClass: Record<number, number>;
  total: number;
}

export interface BlockedEntry {
  ip: string;
  route: string;
  bucket: string;
  createTime: Date;
}

const RING_SIZE = 60;
const BLOCKED_CAP = 500;

/**
 * 流量采集器（纯内存，无 I/O，不依赖 Fastify 与 DB）。
 *
 * v2：不再落库（traffic_stats / traffic_blocked 表已随 Greenfield 移除）。
 * 保留 60 分钟环形缓冲（实时曲线）+ 429 blocked 内存列表（限流误伤排查），
 * 两者都是进程内存，重启即丢 —— 实时诊断的价值在即时性，不值得持久化。
 */
export class TrafficCollector {
  private readonly ring: Array<MinuteSlice | undefined> = new Array(RING_SIZE);
  private blocked: BlockedEntry[] = [];

  record(_route: string, statusCode: number, at: Date = new Date()): void {
    const statusClass = Math.floor(statusCode / 100);
    const ms = at.getTime();
    const minuteTs = Math.floor(ms / 60_000) * 60_000;
    const idx = (minuteTs / 60_000) % RING_SIZE;
    const slot = this.ring[idx];
    if (!slot || slot.minuteTs !== minuteTs) {
      this.ring[idx] = { minuteTs, byClass: { [statusClass]: 1 }, total: 1 };
    } else {
      slot.byClass[statusClass] = (slot.byClass[statusClass] ?? 0) + 1;
      slot.total++;
    }
  }

  recordBlocked(entry: Omit<BlockedEntry, 'createTime'>): void {
    this.blocked.push({ ...entry, createTime: new Date() });
    if (this.blocked.length > BLOCKED_CAP) this.blocked.shift();
  }

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

  /** 最近 N 条 429 记录（最新优先） */
  recentBlocked(limit = 100): BlockedEntry[] {
    return [...this.blocked].reverse().slice(0, limit);
  }
}
