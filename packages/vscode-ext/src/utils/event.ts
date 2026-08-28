/** 可释放句柄。 */
export interface Disposable {
  dispose(): void;
}

/** 事件订阅函数：传入监听器，返回可释放句柄。 */
export type Event<T> = (listener: (e: T) => void) => Disposable;

/**
 * 极简事件发射器（无 vscode 依赖，便于在纯数据层与单测中使用）。
 */
export class EventEmitter<T> {
  private readonly listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// ─── 类型化事件体系 ───

/** 事件基类：所有业务事件由此派生。 */
export abstract class AppEvent {
  readonly timestamp = Date.now();
  readonly source: string;

  constructor(source?: string) {
    this.source = source ?? this.constructor.name;
  }
}

/** 连接/分组变更事件。 */
export class ConnectionChangedEvent extends AppEvent {
  constructor(
    readonly kind: 'connection' | 'group',
    readonly operation: 'create' | 'update' | 'delete' | 'move',
    readonly id?: string,
    source?: string,
  ) {
    super(source ?? 'ConnectionStore');
  }
}

/** 数据变更事件（表级增删改/DDL）。 */
export class DataChangeEvent extends AppEvent {
  constructor(
    readonly connId: string,
    readonly database: string,
    readonly table: string,
    readonly operation: 'insert' | 'update' | 'delete' | 'ddl',
  ) {
    super('DataService');
  }
}

/** 查询执行事件（审计/指标）。 */
export class QueryExecutedEvent extends AppEvent {
  constructor(
    readonly connId: string,
    readonly sql: string,
    readonly duration: number,
    readonly rowCount: number,
    readonly error?: string,
  ) {
    super('QueryRunner');
  }
}

/** 同步事件（push/pull/冲突）。 */
export class SyncEvent extends AppEvent {
  constructor(
    readonly type: 'push' | 'pull' | 'applied' | 'error',
    readonly details?: string,
  ) {
    super('SyncManager');
  }
}

/** 历史记录变更事件。 */
export class HistoryChangedEvent extends AppEvent {
  constructor(readonly operation: 'add' | 'clear' | 'merge') {
    super('HistoryStore');
  }
}

/** 认证状态变更事件（登录/登出）。组织缓存据此整用户失效（§6.2 的 401 清认证）。 */
export class AuthEvent extends AppEvent {
  constructor(readonly kind: 'login' | 'logout') {
    super('AuthService');
  }
}

// ─── 事件总线 ───

interface HandlerEntry {
  handler: (event: AppEvent) => void | Promise<void>;
  priority: number;
}

/** 单事件类型最大订阅数，防止无限订阅耗尽内存。 */
const MAX_HANDLERS_PER_TYPE = 100;

/** 单 handler 最大执行时间（ms），超时后继续执行下一个 handler。 */
const HANDLER_TIMEOUT_MS = 30_000;

/**
 * 类型化事件总线。
 *
 * 消费方按事件类型（构造函数）订阅，可指定优先级（数字越小越先执行）。
 * 发布时按优先级顺序调用处理函数，支持异步处理。
 * 每个 handler 独立错误隔离 + 超时守卫，保证一条 handler 失败不影响其他。
 *
 * 用法：
 *   eventBus.subscribe(ConnectionChangedEvent, (e) => { ... });
 *   eventBus.publish(new ConnectionChangedEvent('connection', 'create', 'id'));
 */
export class EventBus {
  private readonly handlers = new Map<new (...args: any[]) => AppEvent, HandlerEntry[]>();

  subscribe<T extends AppEvent>(
    type: new (...args: any[]) => T,
    handler: (event: T) => void | Promise<void>,
    priority = 0,
  ): Disposable {
    const list = this.handlers.get(type) ?? [];
    if (!this.handlers.has(type)) this.handlers.set(type, list);

    if (list.length >= MAX_HANDLERS_PER_TYPE) {
      console.warn(`[EventBus] max handlers (${MAX_HANDLERS_PER_TYPE}) reached for ${type.name}, subscription ignored`);
      return { dispose: () => {} };
    }

    const entry: HandlerEntry = { handler: handler as (event: AppEvent) => void | Promise<void>, priority };

    // 插入排序：按 priority 升序找到插入位置，publish 时无需再排序
    const idx = list.findIndex((e) => e.priority > priority);
    if (idx >= 0) {
      list.splice(idx, 0, entry);
    } else {
      list.push(entry);
    }

    return {
      dispose: () => {
        const idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
      },
    };
  }

  async publish<T extends AppEvent>(event: T): Promise<void> {
    const list = this.handlers.get(event.constructor as new (...args: any[]) => T);
    if (!list || list.length === 0) return;

    for (const { handler } of [...list]) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Handler timeout after ${HANDLER_TIMEOUT_MS}ms`)), HANDLER_TIMEOUT_MS);
        });
        try {
          await Promise.race([
            Promise.resolve(handler(event)),
            timeoutPromise,
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch {
        // 忽略单个 handler 的异常/超时，继续执行后续 handler
      }
    }
  }

  /** 查询某事件类型的订阅数量（调试用）。 */
  listenerCount<T extends AppEvent>(type: new (...args: any[]) => T): number {
    return this.handlers.get(type)?.length ?? 0;
  }

  /** 清除所有订阅 */
  dispose(): void {
    this.handlers.clear();
  }
}

/** 全局事件总线单例 */
export const eventBus = new EventBus();