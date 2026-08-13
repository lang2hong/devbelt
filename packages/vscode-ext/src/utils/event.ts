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
