/**
 * Redis 客户端封装（ioredis）。
 *
 * 复制 ARDM 的 ioredis 配置与 sendCommand 切面思路（见 P7 设计文档 §6.2/§6.6）：
 *  - stringNumbers / enableReadyCheck / connectTimeout / family / retryStrategy；
 *  - sendCommand 切面：只读拦截（writeCMD + admin 写 denylist）+ 命令日志。
 * 有意不复制 ARDM 的 TLS 绕过（见 redisTls.ts）。
 */
import Redis, { Cluster, Command, type RedisOptions } from 'ioredis';
import type { RedisCommandSource } from './redisOps.js';
import { isReadCommand } from './redisCommands.js';
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
  /** standalone 主机（cluster/sentinel 模式可省略）。 */
  host?: string;
  port?: number;
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
  /** Sentinel 模式：sentinel 列表 + master 名 + sentinel 认证（ioredis 原生，自动故障切换）。 */
  sentinels?: { host: string; port: number }[];
  sentinelName?: string;
  sentinelPassword?: string;
  /** Cluster 模式：起始节点 + 可选 SSH NAT map + slots 刷新超时。 */
  cluster?: {
    nodes: { host: string; port: number }[];
    natMap?: Record<string, { host: string; port: number }> | ((address: string) => { host: string; port: number } | null);
    slotsRefreshTimeout?: number;
  };
}

/** 集群节点执行单元（按 key 路由或直接投递）。 */
export interface RedisNodeLike {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

/** RedisClient 的公开表面（供 redisOps 的 cluster-aware 分支使用）。 */
export interface RedisClientLike extends RedisCommandSource {
  readonly mode: 'standalone' | 'cluster' | 'sentinel';
  readonly isCluster: boolean;
  ping(): Promise<string>;
  info(section?: string): Promise<string>;
  isAlive(): boolean;
  close(): Promise<void>;
  nodes(): RedisNodeLike[];
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  sendCommandBuffer(name: string, args?: (string | number | Buffer)[]): Promise<unknown>;
  readonly status: string;
}

/** RedisClient 依赖的最小 ioredis 形状（便于单测注入假实现）。 */
export interface RedisConnectionLike {
  sendCommand(command: { name: string; args: (string | number | Buffer)[] }, stream?: unknown, node?: unknown): Promise<unknown>;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  /** 仅 ioredis Cluster 有：按角色取节点。 */
  nodes?(role?: string): unknown[];
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
  /** 命令日志监听者（可多个：审计、面板等）。 */
  private readonly logListeners = new Set<(entry: RedisCommandLog) => void>();
  /** 只读模式：拦截写命令。 */
  readonly readOnly: boolean;
  private readonly sentinel: boolean;
  /** 是否 Redis Cluster。 */
  readonly isCluster: boolean;
  /** 建连超时（ms）：`connect()` 的兜底上限，防重试不停时永久挂起。 */
  private readonly connectTimeoutMs: number;
  private closed = false;

  constructor(options: RedisClientOptions, factory?: RedisConnectionFactory) {
    this.readOnly = options.readOnly === true;
    this.connectTimeoutMs = options.connectTimeout ?? 30_000;
    if (options.onLog) this.logListeners.add(options.onLog);
    const maxRetryTimes = options.maxRetryTimes ?? DEFAULT_RETRY_TIMES;
    // 与 ARDM 的上游方法 retryStragety（原拼写如此）一致：times >= maxRetryTimes 停止，退避 200→400。
    const retryStrategy = (times: number) => (times >= maxRetryTimes ? null : Math.min(times * 200, 1000));
    // Cluster 的**节点级**重试：同样不返回 null。返回 null 会让 ioredis 在重试耗尽后
    // 关闭该节点连接并以 "Connection is closed." flush 队列（内部 promise 无人接管 →
    // 未处理拒绝，CI 偶发红）。改为长退避，由整体 `connect()` 超时兜底。
    const clusterNodeRetryStrategy = (times: number) => (times >= maxRetryTimes ? 30_000 : Math.min(times * 200, 1000));
    const common: RedisOptions = {
      username: options.username,
      password: options.password,
      tls: options.tls,
      stringNumbers: true,
      enableReadyCheck: false,
      connectTimeout: options.connectTimeout ?? 30_000,
      family: 0,
      retryStrategy,
    };
    this.isCluster = !!options.cluster?.nodes?.length;
    this.sentinel = !this.isCluster && !!options.sentinels?.length;

    if (factory) {
      this.client = factory(common);
    } else if (this.isCluster) {
      // Cluster 下无 SELECT：不传 db。
      // 节点级选项：不返回 null 的 retryStrategy（用变量传入，避免字面量剔除字段的 excess 检查）。
      const clusterNodeOptions: RedisOptions = { ...common, retryStrategy: clusterNodeRetryStrategy };
      this.client = new Cluster(options.cluster!.nodes, {
        natMap: options.cluster!.natMap,
        slotsRefreshTimeout: options.cluster!.slotsRefreshTimeout ?? 2000,
        redisOptions: clusterNodeOptions,
        // Cluster 用独立的 `clusterRetryStrategy`（不读 redisOptions.retryStrategy）；
        // 同样不返回 null，理由同上。
        clusterRetryStrategy: clusterNodeRetryStrategy,
      }) as unknown as RedisConnectionLike;
    } else if (this.sentinel) {
      this.client = new Redis({
        ...common,
        db: options.db,
        sentinels: options.sentinels,
        name: options.sentinelName,
        sentinelPassword: options.sentinelPassword,
        // Sentinel 模式下 ioredis 只有在这两项都设置时才用 TLS 连 sentinel；
        // 否则即便勾了 TLS，AUTH/sentinelPassword/数据仍走明文。
        enableTLSForSentinelMode: !!options.tls,
        sentinelTLS: options.tls,
      }) as unknown as RedisConnectionLike;
    } else {
      this.client = new Redis({
        ...common,
        host: options.host,
        port: options.port,
        db: options.db,
      }) as unknown as RedisConnectionLike;
    }
    // ioredis 的连接/命令错误会以 'error' 事件发出；EventEmitter 的 'error' 若无监听会抛出
    // 未捕获异常使宿主崩溃。连接失败已通过 connect()/命令 rejection 反馈调用方，这里兜底监听。
    this.client.on('error', () => { /* 由 connect()/命令路径反馈 */ });
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
      // 兜底超时：重试策略不再返回 null（见 clusterRetryStrategy），cluster 拓扑全不可达时
      // ioredis 会一直重试；若无上限，`ready`/`end` 都不会来，Promise 永久挂起（D11）。
      const timer = this.connectTimeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            reject(new Error(`redis connection timed out after ${this.connectTimeoutMs}ms`));
          }, this.connectTimeoutMs)
        : undefined;
      const onReady = () => { cleanup(); resolve(); };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onEnd = () => { cleanup(); reject(new Error('redis connection ended before ready')); };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
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

  /**
   * 字节级命令（二进制安全）：以 `replyEncoding:null` 提交，回复为 Buffer。
   *
   * 经底层 `sendCommand` 提交，因此只读拦截/命令日志切面照常生效；写命令参数
   * 可传 Buffer（如 SET 二进制值）。
   */
  async sendCommandBuffer(name: string, args: (string | number | Buffer)[] = []): Promise<unknown> {
    const cmd = new Command(name, args, { replyEncoding: null });
    return this.client.sendCommand(cmd as unknown as { name: string; args: (string | number | Buffer)[] });
  }

  /** 连接模式。 */
  get mode(): 'standalone' | 'cluster' | 'sentinel' {
    if (this.isCluster) return 'cluster';
    return this.sentinel ? 'sentinel' : 'standalone';
  }

  /** 通用命名命令（集群按 key 路由）。 */
  async call(command: string, ...args: (string | number)[]): Promise<unknown> {
    return this.run(command, args);
  }

  /**
   * 节点执行单元：cluster 返回各 master（供按节点 SCAN/INFO/SLOWLOG/DBSIZE 聚合）；
   * standalone/sentinel 返回自身。
   *
   * **仅限读命令**：节点级 `call` 直接投递到节点，**绕过 sendCommand 切面**（只读拦截
   * 与命令日志不生效）。当前调用方只有 SCAN/INFO 等读操作；切勿经此发写命令。
   */
  nodes(): RedisNodeLike[] {
    const nodeFn = (this.client as { nodes?: (role?: string) => unknown[] }).nodes;
    if (!this.isCluster || typeof nodeFn !== 'function') return [this];
    const masters = nodeFn.call(this.client, 'master') as { call(c: string, ...a: unknown[]): Promise<unknown> }[];
    // 节点级 call 直接投递、绕过 sendCommand 切面：这里在 API 层再补一道只读拦截，
    // 防止经节点路径发出写命令（D11：nodes() 绕过只读切面）。
    return masters.map((n) => ({
      call: (c: string, ...a: (string | number)[]) => {
        const name = String(c).toUpperCase();
        const classifyArgs = a.map((x) => (Buffer.isBuffer(x) ? x.toString('latin1') : String(x)));
        if (this.readOnly && !isReadCommand(name, classifyArgs)) {
          return Promise.reject(new RedisReadOnlyError(name));
        }
        return n.call(c, ...a);
      },
    }));
  }

  /** 订阅底层事件（如 sentinel 故障切换、error）。 */
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.client.on(event, listener);
  }

  /** 移除事件监听（面板 dispose 需要，否则监听器持续累积并 post）。 */
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.client.removeListener(event, listener);
  }

  /** 订阅命令日志；返回取消订阅函数。 */
  addLogListener(listener: (entry: RedisCommandLog) => void): () => void {
    this.logListeners.add(listener);
    return () => { this.logListeners.delete(listener); };
  }

  /**
   * 串行化一段「SELECT 归一 + 命令」事务。
   *
   * 同一连接可能被多个 webview 面板共享（S5：键浏览器 + 控制台等），而 `SELECT`
   * 是连接级状态；跨面板并发会在 SELECT 与命令之间交错。所有 RedisView 操作经此
   * 排队，保证事务原子（单面板内的顺序也自然保持）。
   */
  private opChain: Promise<unknown> = Promise.resolve();
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(() => undefined, () => undefined);
    return run;
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
    // 透传全部实参：Cluster 的 sendCommand 可能带第三个 node 参数，旧包装只接两个会丢弃它。
    this.client.sendCommand = (command, stream, ...rest) => {
      const name = String(command?.name ?? '').toUpperCase();
      const rawArgs = Array.isArray(command?.args) ? command.args : [];
      // 判定用原始值（Buffer 按 latin1 还原，避免 <buffer:N> 占位符绕过子命令判定）。
      const classifyArgs = rawArgs.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : String(a)));
      // 只读 fail-closed：不在只读 allowlist（readCMD / admin 只读子命令）内一律拦截。
      if (this.readOnly && !isReadCommand(name, classifyArgs)) {
        return Promise.reject(new RedisReadOnlyError(name));
      }
      // 日志参数把 Buffer 归一成占位符，避免二进制灌入命令日志。
      const args = rawArgs.map((a) => (Buffer.isBuffer(a) ? `<buffer:${a.length}>` : String(a)));
      const loggedArgs = redactCommandArgs(name, args);
      const started = Date.now();
      return (original as (...a: unknown[]) => Promise<unknown>)(command, stream, ...rest).then(
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
    if (!this.logListeners.size) return;
    const entry: RedisCommandLog = {
      command,
      args,
      durationMs: Date.now() - started,
      ok,
      error: ok ? undefined : String(err),
    };
    for (const listener of this.logListeners) {
      try {
        listener(entry);
      } catch {
        /* 日志是旁路设施，不阻断命令 */
      }
    }
  }
}
