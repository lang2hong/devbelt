import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 多窗口互斥：同一台机器上多个 VS Code 窗口共用 globalStorage，监控任务只能由
 * 一个窗口执行。持锁窗口定期写心跳；心跳过期视为窗口已关闭，其他窗口可接手。
 *
 * 这是协作式锁（不是 OS 文件锁）：极端情况下两窗口同时接手，最坏结果是同一次
 * 检查执行两遍，不会造成写入。
 */
export interface MonitorLockOptions {
  dir: string;
  /** 本窗口标识（随机生成，跨重启不同）。 */
  ownerId: string;
  /** 心跳间隔；过期阈值为 3 倍。 */
  heartbeatMs?: number;
  now?: () => number;
}

interface LockFile {
  owner: string;
  heartbeat: number;
  pid: number;
}

export class MonitorLock {
  private readonly file: string;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private held = false;

  constructor(private readonly opts: MonitorLockOptions) {
    this.file = join(opts.dir, 'monitor.lock');
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  get isHeld(): boolean {
    return this.held;
  }

  get staleAfterMs(): number {
    return this.heartbeatMs * 3;
  }

  /**
   * 尝试获取或续期：无锁 / 锁是自己的 / 锁已过期 → 写入自己的心跳并返回 true。
   * 写完再读回确认，减少两个窗口同时接手的窗口期。
   */
  async tryAcquire(): Promise<boolean> {
    const current = await this.read();
    const now = this.now();
    const free = !current || current.owner === this.opts.ownerId || now - current.heartbeat > this.staleAfterMs;
    if (!free) {
      this.held = false;
      return false;
    }
    await this.write({ owner: this.opts.ownerId, heartbeat: now, pid: process.pid });
    const confirmed = await this.read();
    this.held = confirmed?.owner === this.opts.ownerId;
    return this.held;
  }

  /** 主动释放（窗口关闭）：只删除属于自己的锁。 */
  async release(): Promise<void> {
    const current = await this.read();
    this.held = false;
    if (current?.owner === this.opts.ownerId) await rm(this.file, { force: true });
  }

  private async read(): Promise<LockFile | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<LockFile>;
      return typeof raw.owner === 'string' && typeof raw.heartbeat === 'number'
        ? { owner: raw.owner, heartbeat: raw.heartbeat, pid: typeof raw.pid === 'number' ? raw.pid : 0 }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(lock: LockFile): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    const tmp = `${this.file}.${this.opts.ownerId}.tmp`;
    await writeFile(tmp, JSON.stringify(lock), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
  }
}
