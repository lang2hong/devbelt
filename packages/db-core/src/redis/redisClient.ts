/**
 * Redis 客户端封装（ioredis）。
 *
 * 复制 ARDM 的 ioredis 配置与 sendCommand 切面思路（见 P7 设计文档 §6.2/§6.6）：
 *  - stringNumbers / enableReadyCheck / connectTimeout / family / retryStrategy；
 *  - sendCommand 切面：只读拦截（writeCMD + admin 写 denylist）+ 命令日志。
 * 有意不复制 ARDM 的 TLS 绕过（见 redisTls.ts）。
 */
import Redis, { type RedisOptions } from 'ioredis';
import { isWriteCommand } from './redisCommands.js';
import type { RedisTlsOptions } from './redisTls.js';

/** 只读模式下拦截写命令时抛出。 */
export class RedisReadOnlyError extends Error {
  constructor(public readonly command: string) {
    super(`command blocked in read-only mode: ${command}`);
    this.name = 'RedisReadOnlyError';
  }
}

/** 单条命令的执行日志（审计/控制台耗时）。 */
export interface RedisCommandLog {
  command: string;
  args: string[];
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface RedisClientOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: RedisTlsOptions;
  connectTimeout?: number;
  /** 只读模式：拦截写命令。 */
  readOnly?: boolean;
  /** 重试上限（缺省 3），退避 Math.min(times*200,1000)。 */
  maxRetryTimes?: number;
  /** 命令日志回调（审计/控制台）。 */
  onLog?: (entry: RedisCommandLog) => void;
}

/** RedisClient 依赖的最小 ioredis 形状（便于单测注入假实现）。 */
export interface RedisConnectionLike {
  sendCommand(command: { name: string; args: string[] }, stream?: unknown): Promise<unknown>;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  info(section?: string): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  readonly status: string;
}

export type RedisConnectionFactory = (options: RedisOptions) => RedisConnectionLike;

const DEFAULT_RETRY_TIMES = 3;

/** 日志脱敏占位符。 */
const REDACTED = '<redacted>';

/** 整段参数脱敏的命令（凭据载体）。 */
const REDACT_ALL_COMMANDS: ReadonlySet<string> = new Set(['AUTH']);

/** 仅脱敏「子命令之后」参数的命令（父命令 → 需脱敏的子命令）。 */
const REDACT_SUBCOMMANDS: Record<string, readonly string[]> = {
  CONFIG: ['SET'],
  ACL: ['SETUSER'],
};

/** 单条日志参数最大长度：防大 value / keyspace dump 灌爆日志（P7 §十）。 */
const MAX_LOGGED_ARG_LEN = 128;

function truncateArg(value: string): string {
  return value.length > MAX_LOGGED_ARG_LEN ? `${value.slice(0, MAX_LOGGED_ARG_LEN)}…` : value;
}

/**
 * 脱敏命令日志参数（P7 §十：错误/日志中禁止打印密码）。
 * - AUTH：整段参数 → `<redacted>`；
 * - CONFIG SET / ACL SETUSER：保留子命令，其余 → `<redacted>`；
 * - 其余：逐项截断到 128 字符。
 *
 * 只影响日志入参；命令执行仍使用原始参数（见 installGuard）。
 */
export function redactCommandArgs(command: string, args: readonly string[]): string[] {
  const cmd = String(command ?? '').trim().toUpperCase();
  if (REDACT_ALL_COMMANDS.has(cmd)) return args.map(() => REDACTED);
  const subs = REDACT_SUBCOMMANDS[cmd];
  if (subs && subs.includes(String(args[0] ?? '').trim().toUpperCase())) {
    return [String(args[0]), ...args.slice(1).map(() => REDACTED)];
  }
  return args.map(truncateArg);
}

/**
 * Redis 客户端（standalone；Cluster/Sentinel 在 S4）。
 *
 * 只读拦截与命令日志都挂在底层 ioredis 的 `sendCommand` 切面上，因此无论命令
 * 由本类的 ping/info 还是控制台路径发出，都会被统一判定与记录。
 */
export class RedisClient {
  private readonly client: RedisConnectionLike;
  private readonly onLog?: (entry: RedisCommandLog) => void;
  /** 只读模式：拦截写命令。 */
  readonly readOnly: boolean;
  private closed = false;

  constructor(options: RedisClientOptions, factory?: RedisConnectionFactory) {
    this.readOnly = options.readOnly === true;
    this.onLog = options.onLog;
    const maxRetryTimes = options.maxRetryTimes ?? DEFAULT_RETRY_TIMES;
    const redisOptions: RedisOptions = {
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      db: options.db,
      tls: options.tls,
      stringNumbers: true,
      enableReadyCheck: false,
      connectTimeout: options.connectTimeout ?? 30_000,
      family: 0,
      // 与 ARDM 的上游方法 retryStragety（原拼写如此）一致：times >= maxRetryTimes 停止，退避 200→400。
      retryStrategy: (times: number) => (times >= maxRetryTimes ? null : Math.min(times * 200, 1000)),
    };
    const create: RedisConnectionFactory =
      factory ?? ((o) => new Redis(o) as unknown as RedisConnectionLike);
    this.client = create(redisOptions);
    this.installGuard();
  }

  /**
   * 等待连接就绪（ioredis 构造后自动建连）。
   *
   * 终态 `end`（重试耗尽后 ioredis 发 'end' 而非 'error'）必须立即失败，
   * 否则 `ready`/`error` 都不会再来，Promise 永久挂起。
   */
  async connect(): Promise<void> {
    if (this.client.status === 'ready') return;
    if (this.client.status === 'end') throw new Error('redis connection has ended');
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onEnd = () => { cleanup(); reject(new Error('redis connection ended before ready')); };
      const cleanup = () => {
        this.client.removeListener('ready', onReady);
        this.client.removeListener('error', onError);
        this.client.removeListener('end', onEnd);
      };
      this.client.once('ready', onReady);
      this.client.once('error', onError);
      this.client.once('end', onEnd);
    });
  }

  /** PING，返回服务端回执（通常 'PONG'）。 */
  async ping(): Promise<string> {
    return String(await this.run('PING', []));
  }

  /** INFO（可选 section），返回原始文本分节报告。 */
  async info(section?: string): Promise<string> {
    return String(await this.run('INFO', section ? [section] : []));
  }

  /** 通用命名命令（控制台路径）。 */
  async sendCommand(name: string, args: (string | number)[] = []): Promise<unknown> {
    return this.run(name, args);
  }

  isAlive(): boolean {
    return !this.closed && this.client.status === 'ready';
  }

  /** 当前底层连接状态（ioredis status）。 */
  get status(): string {
    return this.client.status;
  }

  /**
   * 关闭连接。幂等。
   *
   * 仅 `ready` 状态发 QUIT：`reconnecting`/`connecting` 下命令会排队，QUIT 可能
   * 长挂；这些状态直接强制断开。catch 只兜「抛错」，不兜「悬挂」，故不依赖它。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client.status !== 'ready') {
      this.client.disconnect(false);
      return;
    }
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }

  private run(name: string, args: (string | number)[]): Promise<unknown> {
    return this.client.call(name, ...args);
  }

  private installGuard(): void {
    const original = this.client.sendCommand.bind(this.client);
    this.client.sendCommand = (command, stream) => {
      const name = String(command?.name ?? '').toUpperCase();
      const args = Array.isArray(command?.args) ? command.args.map((a) => String(a)) : [];
      if (this.readOnly && isWriteCommand(name, args)) {
        return Promise.reject(new RedisReadOnlyError(name));
      }
      const loggedArgs = redactCommandArgs(name, args);
      const started = Date.now();
      return original(command, stream).then(
        (result) => { this.emitLog(name, loggedArgs, started, true); return result; },
        (err: unknown) => { this.emitLog(name, loggedArgs, started, false, err); throw err; },
      );
    };
  }

  private emitLog(
    command: string,
    args: string[],
    started: number,
    ok: boolean,
    err?: unknown,
  ): void {
    if (!this.onLog) return;
    try {
      this.onLog({
        command,
        args,
        durationMs: Date.now() - started,
        ok,
        error: ok ? undefined : String(err),
      });
    } catch {
      /* 日志是旁路设施，不阻断命令 */
    }
  }
}
