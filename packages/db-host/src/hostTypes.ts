/**
 * 宿主能力端口（ports）。
 *
 * db-host 不含任何 `vscode`（或其它宿主）依赖，凡需要宿主能力处一律以这里的
 * 结构化接口表达，由各宿主（vscode-ext / idea-ext）注入具体实现。
 */

/** 等价于 `vscode.Thenable` 的最小 `PromiseLike` 形状（供 Memento 等宿主 API 使用）。 */
export interface ThenableLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): ThenableLike<TResult1 | TResult2>;
}

/**
 * 安全存储端口，等价于 `vscode.SecretStorage` 的最小面。
 * VS Code 的 `SecretStorage` 结构上即满足本接口，无需适配。
 */
export interface SecureStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}