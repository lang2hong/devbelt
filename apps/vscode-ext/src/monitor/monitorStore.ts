import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_HISTORY_POINTS, type MonitorPoint, type MonitorTask } from './monitorTypes';

/**
 * 监控任务的本地存储（`<globalStorage>/monitor/`）：
 *
 * - `tasks.json`：任务定义（原子写：先写临时文件再 rename），不含凭据；
 * - `<taskId>.jsonl`：历史数据点，每次一行，超过上限裁掉最旧的。
 *
 * 不进个人同步、不上传；删除任务时一并删除历史文件。
 */
export class MonitorStore {
  private readonly dir: string;
  private readonly tasksFile: string;
  /** 串行化写入：调度器与命令可能同时更新任务。 */
  private writeChain: Promise<void> = Promise.resolve();
  /** 历史行数缓存：避免每次追加都重读整文件。 */
  private readonly historyCounts = new Map<string, number>();

  constructor(storageRoot: string, private readonly maxPoints = MAX_HISTORY_POINTS) {
    this.dir = join(storageRoot, 'monitor');
    this.tasksFile = join(this.dir, 'tasks.json');
  }

  get directory(): string {
    return this.dir;
  }

  async loadTasks(): Promise<MonitorTask[]> {
    try {
      const raw = JSON.parse(await readFile(this.tasksFile, 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.filter(isTask) : [];
    } catch {
      return [];
    }
  }

  saveTasks(tasks: readonly MonitorTask[]): Promise<void> {
    const snapshot = JSON.stringify(tasks, null, 2);
    const run = async (): Promise<void> => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.tasksFile}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.tasksFile);
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  async appendPoint(taskId: string, point: MonitorPoint): Promise<void> {
    assertTaskId(taskId);
    await mkdir(this.dir, { recursive: true });
    const file = this.historyFile(taskId);
    await appendFile(file, `${JSON.stringify(point)}\n`, { encoding: 'utf8', mode: 0o600 });
    // 未缓存时数一次（已包含刚追加的这一行）；之后按缓存递增。
    const cached = this.historyCounts.get(taskId);
    const count = cached === undefined ? await this.countLines(file) : cached + 1;
    if (count > this.maxPoints) {
      const points = await this.readHistory(taskId);
      const kept = points.slice(-this.maxPoints);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, kept.map((p) => JSON.stringify(p)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
      this.historyCounts.set(taskId, kept.length);
    } else {
      this.historyCounts.set(taskId, count);
    }
  }

  async readHistory(taskId: string): Promise<MonitorPoint[]> {
    assertTaskId(taskId);
    try {
      const text = await readFile(this.historyFile(taskId), 'utf8');
      const out: MonitorPoint[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const point = JSON.parse(line) as MonitorPoint;
          if (point && typeof point.at === 'number') out.push(point);
        } catch {
          // 损坏行（写入中断）跳过，不影响其余历史。
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async deleteHistory(taskId: string): Promise<void> {
    assertTaskId(taskId);
    this.historyCounts.delete(taskId);
    await rm(this.historyFile(taskId), { force: true });
  }

  private historyFile(taskId: string): string {
    return join(this.dir, `${taskId}.jsonl`);
  }

  private async countLines(file: string): Promise<number> {
    try {
      const text = await readFile(file, 'utf8');
      return text.split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }
}

/** 任务 id 用作文件名：只允许安全字符，防止路径穿越。 */
function assertTaskId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid monitor task id: ${id}`);
}

function isTask(value: unknown): value is MonitorTask {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t.id)
    && (t.kind === 'rowCount' || t.kind === 'metric' || t.kind === 'newRows')
    && typeof t.connId === 'string'
    && typeof t.table === 'string'
    && typeof t.intervalMs === 'number'
    && !!t.condition && typeof t.condition === 'object'
    && (t.status === 'running' || t.status === 'paused' || t.status === 'error');
}
